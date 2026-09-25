import { randomUUID, type KeyObject } from 'node:crypto';
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

import { readApiKeyClaims, type IApiKeyClaims } from '@/features/auth/auth.module';
import {
  clientFromInitialize,
  clientFromUserAgent,
  type IAnalytics,
  type IAnalyticsProperties,
  type IClientInfo,
} from '@/core/analytics/analytics.module';
import { logger } from '@/shared/logger/logger.module';
import type { TToolName } from '@/shared/tool/tool.module';

import { runWithToolCall, type IToolCallDetails } from './call-context';
import type { TErrorCode } from './error-code';
import { SERVICE_NAME } from './otel';

const WRITE_TOOL = 'glomo_api_write';

interface IPendingCall {
  toolName: TToolName;
  mcpRequestId: string;
  startedAt: number;
  span: Span;
  details: IToolCallDetails;
  identity: IApiKeyClaims | undefined;
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
  /** Verifies API key signatures when set. null means verification is required but impossible. */
  jwtPublicKey?: KeyObject | null;
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
      identity: this.identify(extra),
      client: clientFromUserAgent(header(extra, 'user-agent')),
    };
  }

  private onInitialize(message: JSONRPCRequest, extra: MessageExtraInfo | undefined): void {
    const clientInfo = (message.params as { clientInfo?: unknown } | undefined)?.clientInfo;
    const client = clientInfo ? clientFromInitialize(clientInfo) : clientFromUserAgent(header(extra, 'user-agent'));
    this.options.analytics.track('mcp_session_submitted', this.identify(extra), {
      client_name: client.clientName,
      client_version: client.clientVersion,
      mcp_request_id: randomUUID(),
    });
  }

  private identify(extra: MessageExtraInfo | undefined): IApiKeyClaims | undefined {
    const { jwtPublicKey } = this.options;
    if (jwtPublicKey === null) return undefined;
    return readApiKeyClaims(extra?.authInfo?.token, jwtPublicKey);
  }

  private finish(call: IPendingCall, message: JSONRPCResponse | JSONRPCError): void {
    const { toolName, mcpRequestId, span, details, identity, client } = call;
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

    if (toolName === WRITE_TOOL) {
      context.with(trace.setSpan(context.active(), span), () =>
        logger.info('glomo_api_write call', {
          merchantId: identity?.sub,
          operationId: details.operationId,
          httpStatus: details.httpStatus,
          downstreamRequestId: details.downstreamRequestId,
          status,
          errorCode,
          mcpRequestId,
        }),
      );
    }
    span.end();

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
    this.options.analytics.track('mcp_tool_submitted', identity, properties);
    if (errorCode) this.options.analytics.track('mcp_tool_failed', identity, { ...properties, error_code: errorCode });
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
