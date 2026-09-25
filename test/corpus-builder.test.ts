import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, parseLlms, DOCS_ORIGIN } from '@/core/docs/docs.module';

const LLMS = `# Glomopay docs

## Payin
Collecting money.
 - [Purpose Codes](https://docs.glomo.one/payin/purpose-codes.md)
 - [Purpose Codes duplicate](https://docs.glomo.one/payin/purpose-codes.md)
 - [API reference page](https://docs.glomo.one/api-reference/create-payout.md)
 - [Off-host page](https://evil.example.com/payin/steal.md)
 - [Not markdown](https://docs.glomo.one/payin/index.html)

## Platform
 - [Webhooks](https://docs.glomo.one/platform/webhooks.md)
`;

const MD = { 'content-type': 'text/markdown' };

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe('parseLlms', () => {
  it('keeps only unique in-domain https .md pages and excludes api-reference', () => {
    const urls = parseLlms(LLMS).map((entry) => entry.url);
    expect(urls).toEqual(['https://docs.glomo.one/payin/purpose-codes.md', 'https://docs.glomo.one/platform/webhooks.md']);
  });
});

describe('buildCorpus', () => {
  it('fetches only the allowlisted pages (off-host, api-reference, non-md, duplicates excluded)', async () => {
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, LLMS, { 'content-type': 'text/plain' });
    nock(DOCS_ORIGIN).get('/payin/purpose-codes.md').reply(200, '# Purpose Codes\nP1006', MD);
    nock(DOCS_ORIGIN).get('/platform/webhooks.md').reply(200, '# Webhooks\nHMAC SHA-256', MD);

    const corpus = await buildCorpus();
    expect(corpus.map((page) => page.url)).toEqual(['https://docs.glomo.one/payin/purpose-codes.md', 'https://docs.glomo.one/platform/webhooks.md']);
  });

  it('fails closed when a listed page does not return 200 markdown', async () => {
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, LLMS, { 'content-type': 'text/plain' });
    nock(DOCS_ORIGIN).get('/payin/purpose-codes.md').reply(200, '# ok', MD);
    nock(DOCS_ORIGIN).get('/platform/webhooks.md').times(2).reply(404);

    await expect(buildCorpus()).rejects.toThrow();
  });

  it('refuses a non-docs llms.txt URL', async () => {
    await expect(buildCorpus('https://evil.example.com/llms.txt')).rejects.toThrow();
  });
});
