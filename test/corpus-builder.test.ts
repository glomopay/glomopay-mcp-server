import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, parseLlmsFull, parseLlmsIndex, DOCS_ORIGIN } from '@/core/docs/docs.module';

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

const LLMS_INDEX = `# Glomo developer documentation

## Payin
 - [Purpose Codes](https://docs.glomo.one/payin/purpose-codes.md): Payin purpose codes.
 - [API specification](https://docs.glomo.one/api-reference/openapi.md): Generated, excluded.

## Platform
 - [Webhooks](https://docs.glomo.one/platform/webhooks.md): Signed events.
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

describe('parseLlmsIndex', () => {
  it('reads bullet links, strips .md, drops api-reference and off-host, dedupes', () => {
    const index = `${LLMS_INDEX}\n - [Duplicate](https://docs.glomo.one/platform/webhooks.md)\n - [Off-host](https://evil.example.com/platform/webhooks.md)\n`;
    expect(parseLlmsIndex(index)).toEqual(['https://docs.glomo.one/payin/purpose-codes', 'https://docs.glomo.one/platform/webhooks']);
  });
});

describe('buildCorpus', () => {
  it('builds pages from the full file and its index', async () => {
    nock(DOCS_ORIGIN).get('/llms-full.txt').reply(200, LLMS_FULL, TEXT);
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, LLMS_INDEX, TEXT);
    const corpus = await buildCorpus();
    expect(corpus.map((page) => page.url)).toEqual(['https://docs.glomo.one/payin/purpose-codes', 'https://docs.glomo.one/platform/webhooks']);
  });

  it('fails closed on a non-200 even when the body is text', async () => {
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, LLMS_INDEX, TEXT);
    nock(DOCS_ORIGIN).get('/llms-full.txt').times(2).reply(503, 'service unavailable', TEXT);
    await expect(buildCorpus()).rejects.toThrow(/503/);
  });

  it('fails closed on a non-text content type', async () => {
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, LLMS_INDEX, TEXT);
    nock(DOCS_ORIGIN).get('/llms-full.txt').times(2).reply(200, '<html>soft 404</html>', { 'content-type': 'text/html' });
    await expect(buildCorpus()).rejects.toThrow(/text\/html/);
  });

  it('fails the build when the index lists a page the full file is missing', async () => {
    const index = `${LLMS_INDEX}\n - [Payout codes](https://docs.glomo.one/payout/purpose-codes.md)\n`;
    nock(DOCS_ORIGIN).get('/llms-full.txt').reply(200, LLMS_FULL, TEXT);
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, index, TEXT);
    await expect(buildCorpus()).rejects.toThrow(/does not match[\s\S]*missing/);
  });

  it('fails the build when the full file carries a page the index does not list', async () => {
    const index = ` - [Webhooks](https://docs.glomo.one/platform/webhooks.md)\n`;
    nock(DOCS_ORIGIN).get('/llms-full.txt').reply(200, LLMS_FULL, TEXT);
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, index, TEXT);
    await expect(buildCorpus()).rejects.toThrow(/does not match[\s\S]*unlisted/);
  });

  it('fails closed when the full file has no pages', async () => {
    nock(DOCS_ORIGIN).get('/llms-full.txt').reply(200, '# Title\n\nNo sources here.\n', TEXT);
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, '# Title\n\nNo bullets here.\n', TEXT);
    await expect(buildCorpus()).rejects.toThrow(/no documentation pages/);
  });

  it('refuses a non-docs full-file URL by reason', async () => {
    await expect(buildCorpus('https://evil.example.com/llms-full.txt')).rejects.toThrow(/refusing non-docs/);
  });

  it('refuses a non-https docs URL by reason', async () => {
    await expect(buildCorpus('http://docs.glomo.one/llms-full.txt')).rejects.toThrow(/refusing non-docs/);
  });
});
