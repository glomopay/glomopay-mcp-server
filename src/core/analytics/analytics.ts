import Mixpanel from 'mixpanel';

import type { IApiKeyClaims } from '@/features/auth/auth.module';
import type { TErrorCode } from '@/core/telemetry/telemetry.module';

import type { TClientName } from './client-info';
import { redactSearchQuery } from './search-query-redactor';

export const MIXPANEL_HOST = 'api.mixpanel.com';

export type TAnalyticsEvent = 'mcp_session_submitted' | 'mcp_tool_submitted' | 'mcp_tool_failed';

/** Every per-event property the server may send. Nothing else reaches Mixpanel. */
export interface IAnalyticsProperties {
  tool_name?: string;
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
  track(event: TAnalyticsEvent, identity: IApiKeyClaims | undefined, properties: IAnalyticsProperties): void;
  flush(): Promise<void>;
}

export interface IAnalyticsOptions {
  token?: string;
  sdkVersion: string;
  flushIntervalMs?: number;
  onDropped?: (count: number) => void;
}

const MAX_BATCH = 50;
const MAX_QUEUE = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

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

/**
 * Batched, fire-and-forget Mixpanel emitter. It sets the standard properties itself,
 * never throws into the caller, and counts every event it fails to deliver.
 */
class MixpanelAnalytics implements IAnalytics {
  private client: Mixpanel.Mixpanel;
  private queue: TMixpanelEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight = new Set<Promise<void>>();

  constructor(
    token: string,
    private options: IAnalyticsOptions,
  ) {
    this.client = Mixpanel.init(token, { host: MIXPANEL_HOST, protocol: 'https', geolocate: false, keepAlive: true });
  }

  track(event: TAnalyticsEvent, identity: IApiKeyClaims | undefined, properties: IAnalyticsProperties): void {
    try {
      if (this.queue.length >= MAX_QUEUE) {
        this.dropped(1);
        return;
      }
      this.queue.push({ event, properties: this.buildProperties(identity, properties) });
      this.schedule();
    } catch {
      this.dropped(1);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length > 0) this.send(this.queue.splice(0, MAX_BATCH));
    await Promise.all([...this.inFlight]);
  }

  private buildProperties(identity: IApiKeyClaims | undefined, properties: IAnalyticsProperties): Record<string, string | number> {
    const merchantId = identity?.sub;
    const environment = identity?.env;
    return definedOnly({
      ...properties,
      search_query: properties.search_query === undefined ? undefined : redactSearchQuery(properties.search_query),
      distinct_id: merchantId ?? '',
      time: Date.now(),
      product: 'mcp_server',
      platform: 'backend',
      sdk_version: this.options.sdkVersion,
      environment,
      mode: environment === undefined ? undefined : environment === 'production' ? 'live' : 'test',
      merchant_id: merchantId,
    });
  }

  private schedule(): void {
    if (this.queue.length >= MAX_BATCH) {
      this.send(this.queue.splice(0, MAX_BATCH));
    }
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.send(this.queue.splice(0, MAX_BATCH));
      if (this.queue.length > 0) this.schedule();
    }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  private send(batch: TMixpanelEvent[]): void {
    if (batch.length === 0) return;
    const request = new Promise<void>((resolve) => {
      try {
        this.client.track_batch(batch, (errors) => {
          if (Array.isArray(errors) ? errors.some(Boolean) : errors) this.dropped(batch.length);
          resolve();
        });
      } catch {
        this.dropped(batch.length);
        resolve();
      }
    });
    this.inFlight.add(request);
    void request.finally(() => this.inFlight.delete(request));
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
