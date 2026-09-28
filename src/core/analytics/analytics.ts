import type { TErrorCode, TVerifiedCaller } from '@/core/telemetry/telemetry.module';
import type { TToolName } from '@/shared/tool/tool.module';

import type { TClientName } from './client-info';
import { redactSearchQuery } from './search-query-redactor';

export const DEFAULT_MIXPANEL_HOST = 'api.mixpanel.com';

export type TAnalyticsEvent = 'mcp_session_submitted' | 'mcp_tool_submitted' | 'mcp_tool_failed';

/** Every per-event property the server may send. Nothing else reaches Mixpanel. */
export interface IAnalyticsProperties {
  tool_name?: TToolName;
  operation_id?: string;
  status?: 'success' | 'failed';
  error_code?: TErrorCode;
  http_status?: number;
  duration_ms?: number;
  result_count?: number;
  search_query?: string;
  client_name: TClientName;
  client_version?: string;
  mcp_request_id: string;
}

export interface IAnalytics {
  track(event: TAnalyticsEvent, caller: TVerifiedCaller | undefined, properties: IAnalyticsProperties): void;
  flush(): Promise<void>;
}

export interface IAnalyticsOptions {
  token?: string;
  /** Mixpanel ingestion host, or a full origin. */
  host?: string;
  sdkVersion: string;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  onDropped?: (count: number) => void;
}

const SUBJECT_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const ENVIRONMENTS: readonly string[] = ['production', 'sandbox'];

const MAX_BATCH = 50;
const MAX_QUEUE = 1000;
const MAX_IN_FLIGHT = 4;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type TMixpanelEvent = { event: string; properties: Record<string, string | number> };

class NoopAnalytics implements IAnalytics {
  track(): void {}
  async flush(): Promise<void> {}
}

function definedOnly(properties: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function trackUrl(host: string): string {
  const origin = host.includes('://') ? host.replace(/\/+$/, '') : `https://${host}`;
  // ip=0 turns off geolocation; verbose=0 makes a success reply the body "1".
  return `${origin}/track?ip=0&verbose=0`;
}

/**
 * Batched, fire-and-forget Mixpanel emitter over the /track endpoint. It sets the
 * standard properties itself, never throws into the caller, bounds its queue, its
 * concurrent requests and each request's duration, and counts every event it
 * fails to deliver.
 */
class MixpanelAnalytics implements IAnalytics {
  private queue: TMixpanelEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight = new Set<Promise<void>>();
  private flushing = false;
  private url: string;

  constructor(
    private token: string,
    private options: IAnalyticsOptions,
  ) {
    this.url = trackUrl(options.host ?? DEFAULT_MIXPANEL_HOST);
  }

  track(event: TAnalyticsEvent, caller: TVerifiedCaller | undefined, properties: IAnalyticsProperties): void {
    try {
      if (this.queue.length >= MAX_QUEUE) {
        this.dropped(1);
        return;
      }
      this.queue.push({ event, properties: this.buildProperties(caller, properties) });
      if (this.queue.length >= MAX_BATCH) this.sendAvailable();
      this.schedule();
    } catch {
      this.dropped(1);
    }
  }

  /** Resolves once nothing is queued and nothing is in flight. The caller bounds how long it waits. */
  async flush(): Promise<void> {
    this.flushing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      while (this.queue.length > 0 || this.inFlight.size > 0) {
        this.sendAvailable();
        await Promise.race([...this.inFlight]);
      }
    } finally {
      this.flushing = false;
    }
  }

  private buildProperties(caller: TVerifiedCaller | undefined, properties: IAnalyticsProperties): Record<string, string | number> {
    const merchantId = caller?.sub !== undefined && SUBJECT_FORMAT.test(caller.sub) ? caller.sub : undefined;
    const environment = caller?.env !== undefined && ENVIRONMENTS.includes(caller.env) ? caller.env : undefined;
    return definedOnly({
      ...properties,
      search_query: properties.search_query === undefined ? undefined : redactSearchQuery(properties.search_query),
      distinct_id: merchantId ?? '',
      time: Date.now(),
      token: this.token,
      product: 'mcp_server',
      platform: 'backend',
      sdk_version: this.options.sdkVersion,
      environment,
      mode: environment === undefined ? undefined : environment === 'production' ? 'live' : 'test',
      merchant_id: merchantId,
    });
  }

  private schedule(): void {
    if (this.flushing || this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sendAvailable();
      this.schedule();
    }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Sends queued batches while there is request capacity; the rest waits in the bounded queue. */
  private sendAvailable(): void {
    while (this.queue.length > 0 && this.inFlight.size < MAX_IN_FLIGHT) this.send(this.queue.splice(0, MAX_BATCH));
  }

  private send(batch: TMixpanelEvent[]): void {
    const request = this.post(batch)
      .then((delivered) => {
        if (!delivered) this.dropped(batch.length);
      })
      .finally(() => {
        this.inFlight.delete(request);
        this.schedule();
      });
    this.inFlight.add(request);
  }

  private async post(batch: TMixpanelEvent[]): Promise<boolean> {
    try {
      const data = Buffer.from(JSON.stringify(batch)).toString('base64');
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data }).toString(),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
      const body = await response.text();
      return response.ok && body.trim() === '1';
    } catch {
      return false;
    }
  }

  private dropped(count: number): void {
    try {
      this.options.onDropped?.(count);
    } catch {
      // Counting a drop must never surface either.
    }
  }
}

/** A Mixpanel emitter when a token is configured, otherwise a no-op. */
export function createAnalytics(options: IAnalyticsOptions): IAnalytics {
  return options.token ? new MixpanelAnalytics(options.token, options) : new NoopAnalytics();
}
