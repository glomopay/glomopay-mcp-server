import type { ClientRequestArgs } from 'node:http';

import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_URL_FULL, ATTR_URL_PATH } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, NodeTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import { packageVersion } from '@/shared/package-info/package-info.module';

import { currentToolCall } from './call-context';

export const SERVICE_NAME = 'glomo-mcp-server';

export interface ITelemetryPipelines {
  spanProcessors: SpanProcessor[];
  metricReaders: IMetricReader[];
  logRecordProcessors: LogRecordProcessor[];
}

interface IRunningTelemetry {
  tracerProvider: NodeTracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
  disableInstrumentations: () => void;
}

let running: IRunningTelemetry | undefined;

function otlpPipelinesFromEnv(): ITelemetryPipelines | undefined {
  // The OTLP exporters read OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS themselves.
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  return {
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  };
}

/**
 * The downstream URL as origin + the operation's path template, so concrete path
 * values and query strings never become span attributes.
 */
function templatedUrl(request: ClientRequestArgs): Record<string, string> {
  const protocol = request.protocol ?? 'http:';
  const host = String(request.hostname ?? request.host ?? '').replace(/:\d+$/, '');
  const port = request.port ? `:${request.port}` : '';
  const path = currentToolCall()?.pathTemplate ?? '/{path}';
  return { [ATTR_URL_FULL]: `${protocol}//${host}${port}${path}`, [ATTR_URL_PATH]: path };
}

/**
 * Starts OpenTelemetry. With no pipelines passed it exports over OTLP/HTTP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, and stays fully off otherwise.
 */
export function startTelemetry(pipelines?: ITelemetryPipelines): boolean {
  if (running) return true;
  const resolved = pipelines ?? otlpPipelinesFromEnv();
  if (!resolved) return false;

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME, [ATTR_SERVICE_VERSION]: packageVersion });

  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: resolved.spanProcessors });
  tracerProvider.register();

  const meterProvider = new MeterProvider({ resource, readers: resolved.metricReaders });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({ resource, processors: resolved.logRecordProcessors });
  logs.setGlobalLoggerProvider(loggerProvider);

  const disableInstrumentations = registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [
      new HttpInstrumentation({
        // Incoming calls are covered by the tools/call span; a server span would carry the client's address and User-Agent.
        disableIncomingRequestInstrumentation: true,
        startOutgoingSpanHook: templatedUrl,
      }),
    ],
  });

  running = { tracerProvider, meterProvider, loggerProvider, disableInstrumentations };
  return true;
}

export async function shutdownTelemetry(): Promise<void> {
  const current = running;
  running = undefined;
  if (!current) return;
  current.disableInstrumentations();
  await Promise.allSettled([current.tracerProvider.shutdown(), current.meterProvider.shutdown(), current.loggerProvider.shutdown()]);
}
