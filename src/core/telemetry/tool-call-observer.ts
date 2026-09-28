import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { context, metrics, trace, SpanKind, SpanStatusCode, type Counter, type Histogram, type Span } from '@opentelemetry/api';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ErrorCode,
  isJSONRPCError,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCError,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';

import type { CredentialVerifier } from '@/features/auth/auth.module';
import {
  clientFromInitialize,
  clientFromUserAgent,
  type IAnalytics,
  type IAnalyticsProperties,
  type IClientInfo,
} from '@/core/analytics/analytics.module';
import { logger } from '@/shared/logger/logger.module';
import type { TToolName } from '@/shared/tool/tool.module';

import { runWithToolCall, type IToolCallDetails, type TVerifiedCaller } from './call-context';
import type { TErrorCode } from './error-code';
import { SERVICE_NAME } from './otel';

const WRITE_TOOL = 'glomo_api_write';

interface IPendingCall {
  toolName: TToolName;
  mcpRequestId: string;
  startedAt: number;
  span: Span;
  details: IToolCallDetails;
  authInfo: MessageExtraInfo['authInfo'];
  client: IClientInfo;
}

export interface IToolMetrics {
  toolCalls: Counter;
  toolDuration: Histogram;
  analyticsDropped: Counter;
}

/** Instruments are created from the global meter, so call this after telemetry has started. */
export function createToolMetrics(): IToolMetrics {
  const meter = metrics.getMeter(SERVICE_NAME);
  return {
    toolCalls: meter.createCounter('mcp.tool.calls', { description: 'tools/call requests, by toolName and status' }),
    toolDuration: meter.createHistogram('mcp.tool.duration', { description: 'tools/call duration, by toolName and status', unit: 'ms' }),
    analyticsDropped: meter.createCounter('mcp.analytics.dropped', { description: 'Analytics events that could not be delivered' }),
  };
}

export interface IToolCallObserverOptions {
  analytics: IAnalytics;
  metrics: IToolMetrics;
  /** The same verifier the dispatcher uses; attribution comes only from a credential it accepts. */
  verifier: CredentialVerifier;
}

function header(extra: MessageExtraInfo | undefined, name: string): string | undefined {
  const value = extra?.requestInfo?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function failureCode(message: JSONRPCResponse | JSONRPCError, reported: TErrorCode | undefined): TErrorCode | undefined {
  if (isJSONRPCError(message)) return reported ?? (message.error.code === ErrorCode.InvalidParams ? 'validation_error' : 'internal');
  if ((message.result as { isError?: boolean }).isError === true) return reported ?? 'internal';
  return undefined;
}

/**
 * Watches one transport's JSON-RPC traffic and turns each initialize and tools/call
 * into analytics events, a span, metrics and (for writes) an audit log line. It
 * never alters a message and never lets its own failure reach the client.
 */
export class ToolCallObserver {
  private tracer = trace.getTracer(SERVICE_NAME);
  private attributing = new Set<Promise<void>>();

  constructor(private options: IToolCallObserverOptions) {}

  attach(transport: Transport, toolNames: ReadonlySet<TToolName>): void {
    const deliver = transport.onmessage;
    if (!deliver) return;
    const send = transport.send.bind(transport);
    const pending = new Map<string | number, IPendingCall>();

    transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      const call = this.safely(() => this.observeRequest(message, extra, toolNames));
      if (!call || !isJSONRPCRequest(message)) return deliver(message, extra);

      pending.set(message.id, call);
      return context.with(trace.setSpan(context.active(), call.span), () => runWithToolCall(call.details, () => deliver(message, extra)));
    };

    transport.send = (message, sendOptions) => {
      if ((isJSONRPCResponse(message) || isJSONRPCError(message)) && pending.has(message.id)) {
        const call = pending.get(message.id)!;
        pending.delete(message.id);
        this.safely(() => this.finish(call, message));
      }
      return send(message, sendOptions);
    };
  }

  private observeRequest(message: JSONRPCMessage, extra: MessageExtraInfo | undefined, toolNames: ReadonlySet<TToolName>): IPendingCall | undefined {
    if (!isJSONRPCRequest(message)) return undefined;
    if (message.method === 'initialize') this.onInitialize(message, extra);
    if (message.method !== 'tools/call') return undefined;

    const requested = message.params?.name;
    const toolName = [...toolNames].find((name) => name === requested);
    if (!toolName) return undefined;

    const mcpRequestId = randomUUID();
    return {
      toolName,
      mcpRequestId,
      startedAt: performance.now(),
      span: this.tracer.startSpan(`tools/call ${toolName}`, { kind: SpanKind.INTERNAL, attributes: { toolName, mcpRequestId } }),
      details: {},
      authInfo: extra?.authInfo,
      client: clientFromUserAgent(header(extra, 'user-agent')),
    };
  }

  private onInitialize(message: JSONRPCRequest, extra: MessageExtraInfo | undefined): void {
    const clientInfo = (message.params as { clientInfo?: unknown } | undefined)?.clientInfo;
    const client = clientInfo ? clientFromInitialize(clientInfo) : clientFromUserAgent(header(extra, 'user-agent'));
    const properties = { client_name: client.clientName, client_version: client.clientVersion, mcp_request_id: randomUUID() };
    this.withCaller(this.verifyCaller(extra?.authInfo), (caller) => this.options.analytics.track('mcp_session_submitted', caller, properties));
  }

  /** Resolves once every event still waiting on credential verification has been handed to analytics. */
  async settle(): Promise<void> {
    while (this.attributing.size > 0) await Promise.allSettled([...this.attributing]);
  }

  /** Verifies a credential the dispatcher did not (initialize, discovery tools, calls refused before dispatch). */
  private async verifyCaller(authInfo: MessageExtraInfo['authInfo']): Promise<TVerifiedCaller | undefined> {
    const credential = await this.options.verifier.resolve({ authInfo });
    return credential.status === 'valid' ? { sub: credential.credential.sub, env: credential.credential.env } : undefined;
  }

  /** Runs `use` now when the caller is already known, otherwise once verification settles. */
  private withCaller(
    caller: TVerifiedCaller | undefined | Promise<TVerifiedCaller | undefined>,
    use: (caller: TVerifiedCaller | undefined) => void,
  ): void {
    if (!(caller instanceof Promise)) {
      use(caller);
      return;
    }
    const pending = caller.then(
      (verified) => this.safely(() => use(verified)),
      () => this.safely(() => use(undefined)),
    );
    this.attributing.add(pending);
    void pending.finally(() => this.attributing.delete(pending));
  }

  private finish(call: IPendingCall, message: JSONRPCResponse | JSONRPCError): void {
    const { toolName, span, details } = call;
    const errorCode = failureCode(message, details.errorCode);
    const status = errorCode ? 'failed' : 'success';
    const durationMs = Math.round(performance.now() - call.startedAt);

    span.setAttributes({
      status,
      ...(details.operationId ? { operationId: details.operationId } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    if (errorCode) span.setStatus({ code: SpanStatusCode.ERROR });

    this.options.metrics.toolCalls.add(1, { toolName, status });
    this.options.metrics.toolDuration.record(durationMs, { toolName, status });
    span.end();

    // The dispatcher reports the caller when it verified the credential; otherwise verify it here, once.
    const caller = details.caller !== undefined ? (details.caller ?? undefined) : this.verifyCaller(call.authInfo);
    this.withCaller(caller, (verified) => this.report(call, verified, status, errorCode, durationMs));
  }

  private report(
    call: IPendingCall,
    caller: TVerifiedCaller | undefined,
    status: 'success' | 'failed',
    errorCode: TErrorCode | undefined,
    durationMs: number,
  ): void {
    const { toolName, mcpRequestId, span, details, client } = call;

    if (toolName === WRITE_TOOL) {
      context.with(trace.setSpan(context.active(), span), () =>
        logger.info('glomo_api_write call', {
          merchantId: caller?.sub,
          operationId: details.operationId,
          httpStatus: details.httpStatus,
          downstreamRequestId: details.downstreamRequestId,
          status,
          errorCode,
          mcpRequestId,
        }),
      );
    }

    const properties: IAnalyticsProperties = {
      tool_name: toolName,
      operation_id: details.operationId,
      status,
      http_status: details.httpStatus,
      duration_ms: durationMs,
      result_count: details.resultCount,
      search_query: details.searchQuery,
      client_name: client.clientName,
      client_version: client.clientVersion,
      mcp_request_id: mcpRequestId,
    };
    this.options.analytics.track('mcp_tool_submitted', caller, properties);
    if (errorCode) this.options.analytics.track('mcp_tool_failed', caller, { ...properties, error_code: errorCode });
  }

  private safely<T>(run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      logger.warn('tool call telemetry failed', { error: error instanceof Error ? error.name : 'unknown' });
      return undefined;
    }
  }
}
