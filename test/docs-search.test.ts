import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, isRefused, resultText, startTestServer, type ITestServer } from './helpers';

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer({ docsCorpusPath: path.resolve(__dirname, 'fixtures/docs-corpus.json') });
  // docs_search makes no downstream calls; allow the in-process server (helpers puts nock.back in lockdown).
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
});

function search(query: string, limit?: number) {
  return callTool(server.url, 'glomopay_docs_search', limit === undefined ? { query } : { query, limit }, 'test');
}

describe('glomopay_docs_search', () => {
  it('ranks the purpose-codes page first for a purpose-code query', async () => {
    const payload = JSON.parse(resultText(await search('purpose code regulator set'))) as { results: { url: string }[] };
    expect(payload.results[0].url).toContain('purpose-codes.md');
  });

  it('ranks the webhooks page first for a signature query', async () => {
    const payload = JSON.parse(resultText(await search('verify webhook signature hmac'))) as { results: { url: string }[] };
    expect(payload.results[0].url).toContain('webhooks.md');
  });

  it('builds the excerpt around the matched term, not the start of the chunk', async () => {
    const payload = JSON.parse(resultText(await search('P1006'))) as { results: { url: string; excerpt: string }[] };
    expect(payload.results[0].url).toContain('purpose-codes.md');
    expect(payload.results[0].excerpt).toContain('P1006');
  });

  it('honours the limit on a query that matches both pages', async () => {
    const all = JSON.parse(resultText(await search('purpose webhook'))) as { results: unknown[] };
    expect(all.results.length).toBe(2);
    const limited = JSON.parse(resultText(await search('purpose webhook', 1))) as { results: unknown[] };
    expect(limited.results.length).toBe(1);
  });

  it('refuses a limit above the maximum', async () => {
    expect(isRefused(await search('purpose', 21))).toBe(true);
  });

  it('refuses an empty query', async () => {
    expect(isRefused(await search(''))).toBe(true);
  });
});
