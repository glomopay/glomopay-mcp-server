import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { startTelemetry, shutdownTelemetry } from '@/core/telemetry/telemetry.module';

import { callTool, startTestServer } from './helpers';

interface IOtlpAttribute {
  key: string;
  value: { stringValue?: string };
}

interface IOtlpExport {
  path: string;
  resources: IOtlpAttribute[][];
}

interface ICollector {
  url: string;
  exports: IOtlpExport[];
  close: () => Promise<void>;
}

// A real local OTLP/HTTP endpoint: it records which signal each export was for and its resource attributes.
async function startCollector(): Promise<ICollector> {
  const exports: IOtlpExport[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const payload = JSON.parse(body) as Record<string, { resource?: { attributes?: IOtlpAttribute[] } }[]>;
      const batches = payload.resourceSpans ?? payload.resourceMetrics ?? payload.resourceLogs ?? [];
      exports.push({ path: req.url ?? '', resources: batches.map((batch) => batch.resource?.attributes ?? []) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, exports, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

let collector: ICollector;

beforeAll(async () => {
  nock.enableNetConnect('127.0.0.1');
  collector = await startCollector();
});

afterAll(async () => {
  await collector.close();
});

/** Starts telemetry from env the way the entrypoint does, serves one tools/call, then shuts down (which flushes every exporter). */
async function exportOneCall(env: Record<string, string | undefined>): Promise<IOtlpExport[]> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  collector.exports.length = 0;
  apply({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, ...env });
  try {
    expect(startTelemetry()).toBe(true);
    const server = await startTestServer();
    await callTool(server.url, 'glomo_api_search', { query: 'payout' });
    await server.close();
  } finally {
    await shutdownTelemetry();
    apply({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined, ...previous });
  }
  return [...collector.exports];
}

function resourceAttribute(exports: IOtlpExport[], path: string, key: string): (string | undefined)[] {
  return exports
    .filter((entry) => entry.path === path)
    .flatMap((entry) => entry.resources)
    .map((attributes) => attributes.find((attribute) => attribute.key === key)?.value.stringValue);
}

describe('deployment.environment', () => {
  it('is set on the resource of every exported span and metric from DEPLOYMENT_ENVIRONMENT', async () => {
    const exports = await exportOneCall({ DEPLOYMENT_ENVIRONMENT: 'staging', OTEL_METRICS_EXPORTER: undefined });
    const spanEnvs = resourceAttribute(exports, '/v1/traces', 'deployment.environment');
    const metricEnvs = resourceAttribute(exports, '/v1/metrics', 'deployment.environment');
    expect(spanEnvs.length).toBeGreaterThan(0);
    expect(metricEnvs.length).toBeGreaterThan(0);
    expect(new Set([...spanEnvs, ...metricEnvs])).toEqual(new Set(['staging']));
    expect(new Set(resourceAttribute(exports, '/v1/traces', 'service.name'))).toEqual(new Set(['glomo-mcp-server']));
  });

  it('is left off the resource when DEPLOYMENT_ENVIRONMENT is unset', async () => {
    const exports = await exportOneCall({ DEPLOYMENT_ENVIRONMENT: undefined, OTEL_METRICS_EXPORTER: undefined });
    const spanEnvs = resourceAttribute(exports, '/v1/traces', 'deployment.environment');
    expect(spanEnvs.length).toBeGreaterThan(0);
    expect(spanEnvs.every((value) => value === undefined)).toBe(true);
  });
});

describe('OTEL_METRICS_EXPORTER', () => {
  for (const value of [undefined, 'otlp']) {
    it(`exports metrics when it is ${value ?? 'unset'}`, async () => {
      const exports = await exportOneCall({ OTEL_METRICS_EXPORTER: value });
      expect(exports.some((entry) => entry.path === '/v1/metrics')).toBe(true);
      expect(exports.some((entry) => entry.path === '/v1/traces')).toBe(true);
    });
  }

  it('turns metrics export off with none, and leaves traces on', async () => {
    const exports = await exportOneCall({ OTEL_METRICS_EXPORTER: 'none' });
    expect(exports.some((entry) => entry.path === '/v1/metrics')).toBe(false);
    expect(exports.some((entry) => entry.path === '/v1/traces')).toBe(true);
  });
});
