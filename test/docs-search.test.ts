import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, resultText, startTestServer, type ITestServer } from './helpers';

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer({ docsCorpusPath: path.resolve(__dirname, 'fixtures/docs-corpus.json') });
  // docs_search makes no downstream calls; allow the in-process server (helpers puts nock.back in lockdown).
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.enableNetConnect();
  await server.close();
});

describe('glomopay_docs_search', () => {
  it('returns cited results ranked by relevance', async () => {
    const response = await callTool(server.url, 'glomopay_docs_search', { query: 'purpose code regulator set' }, 'test');
    const payload = JSON.parse(resultText(response)) as { results: { url: string; title: string; excerpt: string }[] };
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].url).toContain('purpose-codes.md');
    expect(payload.results[0].excerpt.length).toBeGreaterThan(0);
  });

  it('ranks a different page first for a different query', async () => {
    const response = await callTool(server.url, 'glomopay_docs_search', { query: 'verify webhook signature hmac' }, 'test');
    const payload = JSON.parse(resultText(response)) as { results: { url: string }[] };
    expect(payload.results[0].url).toContain('webhooks.md');
  });

  it('respects the limit', async () => {
    const response = await callTool(server.url, 'glomopay_docs_search', { query: 'glomo', limit: 1 }, 'test');
    const payload = JSON.parse(resultText(response)) as { results: unknown[] };
    expect(payload.results.length).toBeLessThanOrEqual(1);
  });
});
