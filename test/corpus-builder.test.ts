import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, parseLlmsFull, DOCS_ORIGIN } from '@/core/docs/docs.module';

const LLMS_FULL = `# Glomo developer documentation

> The full text of every page.

Source: https://docs.glomo.one/payin/purpose-codes
Section: Payin

# Purpose Codes

Codes like P1006 apply to payins.

Source: https://evil.example.com/payin/steal
Section: Payin

# Off-host

Should be dropped.

Source: https://docs.glomo.one/platform/webhooks
Section: Platform

# Webhooks

Signed with HMAC SHA-256.
`;

const TEXT = { 'content-type': 'text/plain' };

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe('parseLlmsFull', () => {
  it('splits pages on Source lines, keeps only in-domain https pages, and reads section + title', () => {
    const pages = parseLlmsFull(LLMS_FULL);
    expect(pages.map((page) => page.url)).toEqual(['https://docs.glomo.one/payin/purpose-codes', 'https://docs.glomo.one/platform/webhooks']);
    expect(pages[0]).toMatchObject({ section: 'Payin', title: 'Purpose Codes' });
    expect(pages[0].content).toContain('P1006');
    expect(pages[0].content).not.toContain('Section:');
  });
});

describe('buildCorpus', () => {
  it('builds pages from the single llms-full.txt fetch', async () => {
    nock(DOCS_ORIGIN).get('/llms-full.txt').reply(200, LLMS_FULL, TEXT);
    const corpus = await buildCorpus();
    expect(corpus.map((page) => page.url)).toEqual(['https://docs.glomo.one/payin/purpose-codes', 'https://docs.glomo.one/platform/webhooks']);
  });

  it('fails closed on a non-200', async () => {
    nock(DOCS_ORIGIN).get('/llms-full.txt').times(2).reply(503);
    await expect(buildCorpus()).rejects.toThrow(/503|failed to fetch/);
  });

  it('fails closed on a non-text content type', async () => {
    nock(DOCS_ORIGIN).get('/llms-full.txt').times(2).reply(200, '<html>soft 404</html>', { 'content-type': 'text/html' });
    await expect(buildCorpus()).rejects.toThrow(/text\/html/);
  });

  it('refuses a non-docs llms-full.txt URL by reason', async () => {
    await expect(buildCorpus('https://evil.example.com/llms-full.txt')).rejects.toThrow(/refusing non-docs/);
  });
});
