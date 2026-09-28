import { metricExporter, metricReader } from './otel-setup';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';

import { flushApps } from '@/core/app/app.module';
import { shutdownTelemetry } from '@/core/telemetry/telemetry.module';
import { callTool, isRefused, jwt, pause, rpcBatch, startBrokenUpstream, startTestServer, type IFakeUpstream, type ITestServer } from './helpers';

const MIXPANEL_TOKEN = 'mixpanel-test-project-token';
const KEY = jwt('sandbox', { sub: 'merch_4f9a8b7c6d5e' });

let sink: IFakeUpstream | undefined;
let app: ITestServer | undefined;

async function droppedTotal(): Promise<number> {
  await metricReader.forceFlush();
  const metric = metricExporter
    .getMetrics()
    .at(-1)
    ?.scopeMetrics.flatMap((scope) => scope.metrics)
    .find((entry) => entry.descriptor.name === 'mcp.analytics.dropped');
  return (metric?.dataPoints[0]?.value as number | undefined) ?? 0;
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) await pause(10);
}

/** An app whose Mixpanel host is a real local socket that never answers. */
async function startWithSilentMixpanel(analyticsTimeoutMs: number): Promise<{ sink: IFakeUpstream; app: ITestServer }> {
  sink = await startBrokenUpstream('silent');
  app = await startTestServer({ env: { MIXPANEL_TOKEN, MIXPANEL_HOST: sink.origin }, analyticsTimeoutMs });
  return { sink, app };
}

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(async () => {
  await app?.close();
  await sink?.close();
  app = undefined;
  sink = undefined;
  // Settle whatever the closed sink left queued, so no drop lands in the next test.
  await flushApps();
});

afterAll(async () => {
  nock.enableNetConnect();
  await shutdownTelemetry();
});

describe('analytics delivery against a Mixpanel host that never answers', () => {
  it('keeps at most 4 requests in flight', async () => {
    const { sink, app } = await startWithSilentMixpanel(60_000);
    for (let i = 0; i < 7; i++) {
      const response = await callTool(app.url, 'glomo_api_search', { query: 'payout' }, KEY);
      expect(isRefused(response)).toBe(false);
      await pause(20);
    }
    await until(() => sink.requests.length >= 4);
    await pause(100);
    // None of them ever completes, so every request received is still in flight.
    expect(sink.requests.map((request) => `${request.method} ${request.path}`)).toEqual(Array(4).fill('POST /track?ip=0&verbose=0'));
  });

  it('gives up on a request after its timeout and counts its events as dropped', async () => {
    const before = await droppedTotal();
    const { sink, app } = await startWithSilentMixpanel(100);
    await callTool(app.url, 'glomo_api_search', { query: 'payout' }, KEY);
    await until(async () => (await droppedTotal()) > before);
    await pause(200);
    expect(await droppedTotal()).toBe(before + 1);
    expect(sink.requests).toHaveLength(1);
  });

  it('caps the queue at 1000 events and counts the overflow as dropped', async () => {
    const before = await droppedTotal();
    const { sink, app } = await startWithSilentMixpanel(60_000);
    const calls = Array.from({ length: 500 }, () => ({ method: 'tools/call', params: { name: 'glomo_api_search', arguments: { query: 'payout' } } }));
    for (let i = 0; i < 3; i++) await rpcBatch(app.url, calls, KEY);
    await pause(100);

    // 1500 events: at most 4 batches of 50 are in flight, 1000 wait in the queue, the rest are dropped.
    const dropped = (await droppedTotal()) - before;
    expect(sink.requests.length).toBeLessThanOrEqual(4);
    expect(dropped).toBeGreaterThanOrEqual(1500 - 1000 - 4 * 50);
    expect(dropped).toBeLessThanOrEqual(1500 - 1000 - 4);
  });

  it('flush waits for requests started while it runs, not only those in flight when it began', async () => {
    const slowSink = await startBrokenUpstream('status', { body: '1', delayMs: 150 });
    sink = slowSink;
    app = await startTestServer({ env: { MIXPANEL_TOKEN, MIXPANEL_HOST: slowSink.origin } });

    await callTool(app.url, 'glomo_api_search', { query: 'first' }, KEY);
    await until(() => slowSink.requests.length >= 1);

    const flushed = flushApps();
    await callTool(app.url, 'glomo_api_search', { query: 'second' }, KEY);
    await flushed;

    expect(slowSink.requests.length).toBeGreaterThanOrEqual(2);
    expect(slowSink.stats.answered).toBe(slowSink.requests.length);
  });
});
