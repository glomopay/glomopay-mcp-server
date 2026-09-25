import type { ClientRequestArgs } from 'node:http';

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_URL_FULL } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import { packageVersion } from '@/shared/package-info/package-info.module';

export const SERVICE_NAME = 'glomo-mcp-server';

export interface ITelemetryPipelines {
  spanProcessors: SpanProcessor[];
  metricReaders: IMetricReader[];
  logRecordProcessors: LogRecordProcessor[];
}

/** Hosts whose outgoing calls are not traced (the analytics sink). */
const UNTRACED_HOSTS = new Set(['api.mixpanel.com']);

let sdk: NodeSDK | undefined;

function otlpPipelinesFromEnv(): ITelemetryPipelines | undefined {
  // The OTLP exporters read OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS themselves.
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  return {
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  };
}

function hostOf(request: ClientRequestArgs): string {
  return String(request.hostname ?? request.host ?? '').replace(/:\d+$/, '');
}

// Downstream query strings carry caller-supplied filter values; keep only the path.
function urlWithoutQuery(request: ClientRequestArgs): string {
  const protocol = request.protocol ?? 'http:';
  const port = request.port ? `:${request.port}` : '';
  const pathOnly = String(request.path ?? '/').split('?')[0];
  return `${protocol}//${hostOf(request)}${port}${pathOnly}`;
}

/**
 * Starts the OTel SDK. With no pipelines passed it exports over OTLP/HTTP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, and stays fully off otherwise.
 */
export function startTelemetry(pipelines?: ITelemetryPipelines): boolean {
  if (sdk) return true;
  const resolved = pipelines ?? otlpPipelinesFromEnv();
  if (!resolved) return false;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME, [ATTR_SERVICE_VERSION]: packageVersion }),
    spanProcessors: resolved.spanProcessors,
    metricReaders: resolved.metricReaders,
    logRecordProcessors: resolved.logRecordProcessors,
    instrumentations: [
      new HttpInstrumentation({
        ignoreOutgoingRequestHook: (request) => UNTRACED_HOSTS.has(hostOf(request)),
        startOutgoingSpanHook: (request) => ({ [ATTR_URL_FULL]: urlWithoutQuery(request) }),
      }),
    ],
  });
  sdk.start();
  return true;
}

export async function shutdownTelemetry(): Promise<void> {
  const running = sdk;
  sdk = undefined;
  await running?.shutdown();
}
