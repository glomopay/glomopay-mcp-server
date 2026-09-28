import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';

import { startTelemetry } from '@/core/telemetry/telemetry.module';

// Imported before anything that loads an HTTP client, the same order the entrypoint
// uses, so the SDK's HTTP instrumentation is in place. The exporters are the SDK's
// own in-memory ones.
export const spans = new InMemorySpanExporter();
export const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
export const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
export const logRecords = new InMemoryLogRecordExporter();

startTelemetry({
  spanProcessors: [new SimpleSpanProcessor(spans)],
  metricReaders: [metricReader],
  logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logRecords })],
});
