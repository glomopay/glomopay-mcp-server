import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, parseLlmsFull, parseLlmsIndex, DOCS_ORIGIN, SKILLS_INDEX_URL } from '@/core/docs/docs.module';

const LLMS_FULL = `# Glomo developer documentation

> The full text of every page.

Source: https://docs.glomo.one/payin/purpose-codes
Section: Payin

# Purpose Codes

Codes like P1006 apply to payins.

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
const JSON_TYPE = { 'content-type': 'application/json' };

const SKILLS_DIR = '/.well-known/skills/';
const SKILLS_INDEX_PATH = new URL(SKILLS_INDEX_URL).pathname;

// The published skills catalogue as recorded in the docs cassette (index.json and
// every listed SKILL.md). Failure cases change one recorded response.
const recordedSkills = nock
  .loadDefs(path.resolve(__dirname, 'fixtures/cassettes/docs-corpus.json'))
  .filter((def) => String(def.path).startsWith(SKILLS_DIR));
const recorded = (pathname: string) => recordedSkills.find((def) => def.path === pathname)!.response as string;
const skillPath = (name: string) => `${SKILLS_DIR}${name}/SKILL.md`;
const recordedNames = (JSON.parse(recorded(SKILLS_INDEX_PATH)) as { skills: { name: string }[] }).skills.map((skill) => skill.name);

function nockDocs(index: string = LLMS_INDEX) {
  nock(DOCS_ORIGIN).get('/llms-full.txt').reply(200, LLMS_FULL, TEXT);
  nock(DOCS_ORIGIN).get('/llms.txt').reply(200, index, TEXT);
}

function nockSkills(overrides: Record<string, nock.ReplyBody | null> = {}) {
  nock.define(recordedSkills.filter((def) => !(String(def.path) in overrides)));
  for (const [pathname, body] of Object.entries(overrides)) {
    if (body === null) continue;
    const type = pathname === SKILLS_INDEX_PATH ? JSON_TYPE : { 'content-type': 'text/markdown; charset=utf-8' };
    nock(DOCS_ORIGIN).get(pathname).reply(200, body, type);
  }
}

function withIndex(edit: (skills: { name: unknown; files: unknown }[]) => unknown[]) {
  const index = JSON.parse(recorded(SKILLS_INDEX_PATH)) as { skills: { name: unknown; files: unknown }[] };
  return JSON.stringify({ ...index, skills: edit(index.skills) });
}

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
  it('splits pages on Source lines and reads section + title', () => {
    const pages = parseLlmsFull(LLMS_FULL);
    expect(pages.map((page) => page.url)).toEqual(['https://docs.glomo.one/payin/purpose-codes', 'https://docs.glomo.one/platform/webhooks']);
    expect(pages[0]).toMatchObject({ section: 'Payin', title: 'Purpose Codes' });
    expect(pages[0].content).toContain('P1006');
    expect(pages[0].content).not.toContain('Section:');
  });

  it('throws on a non-docs Source URL rather than silently truncating the previous page', () => {
    const text = `${LLMS_FULL}\nSource: https://evil.example.com/steal\nSection: Payin\n\n# Off-host\n\nbody\n`;
    expect(() => parseLlmsFull(text)).toThrow(/non-docs Source URL/);
  });

  it('throws on a duplicate Source URL rather than splitting a page in two', () => {
    const text = `${LLMS_FULL}\nSource: https://docs.glomo.one/payin/purpose-codes\nSection: Payin\n\n# Again\n\nbody\n`;
    expect(() => parseLlmsFull(text)).toThrow(/duplicate Source URL/);
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
    nockDocs();
    nockSkills();
    const corpus = await buildCorpus();
    const docs = corpus.filter((page) => page.section !== 'Skills');
    expect(docs.map((page) => page.url)).toEqual(['https://docs.glomo.one/payin/purpose-codes', 'https://docs.glomo.one/platform/webhooks']);
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

  it('refuses a non-docs index URL by reason', async () => {
    await expect(buildCorpus('https://docs.glomo.one/llms-full.txt', 'https://evil.example.com/llms.txt')).rejects.toThrow(/refusing non-docs/);
  });

  it('refuses a non-https docs URL by reason', async () => {
    await expect(buildCorpus('http://docs.glomo.one/llms-full.txt')).rejects.toThrow(/refusing non-docs/);
  });

  it('refuses a non-docs skills index URL by reason', async () => {
    await expect(buildCorpus(undefined, undefined, 'https://evil.example.com/.well-known/skills/index.json')).rejects.toThrow(/refusing non-docs/);
  });

  it('fails closed on a redirect without requesting the other host', async () => {
    nock(DOCS_ORIGIN).get('/llms.txt').reply(200, LLMS_INDEX, TEXT);
    nock(DOCS_ORIGIN).get('/llms-full.txt').times(2).reply(302, '', { location: 'https://evil.example.com/llms-full.txt' });
    const offHost = nock('https://evil.example.com').get('/llms-full.txt').times(2).reply(200, LLMS_FULL, TEXT);
    await expect(buildCorpus()).rejects.toThrow(/failed to fetch https:\/\/docs\.glomo\.one\/llms-full\.txt/);
    expect(offHost.isDone()).toBe(false);
  });
});

describe('buildCorpus skills', () => {
  it('adds every published skill as its own page after the docs pages', async () => {
    nockDocs();
    nockSkills();
    const skills = (await buildCorpus()).filter((page) => page.section === 'Skills');
    expect(skills.map((page) => page.url)).toEqual(recordedNames.map((name) => `${DOCS_ORIGIN}${skillPath(name)}`));
    expect(skills.find((page) => page.url.endsWith('/glomo-payouts/SKILL.md'))?.title).toBe('Glomo payouts (agent skill)');
    for (const page of skills) {
      expect(page.content).not.toMatch(/^---/);
      expect(page.content).not.toMatch(/^(name|description|metadata):/m);
    }
  });

  it('keeps skills out of the llms.txt cross-check', async () => {
    nockDocs(` - [Purpose Codes](https://docs.glomo.one/payin/purpose-codes.md)\n - [Webhooks](https://docs.glomo.one/platform/webhooks.md)\n`);
    nockSkills();
    await expect(buildCorpus()).resolves.toHaveLength(2 + recordedNames.length);
  });

  it('fails the build when the skills index is unreachable', async () => {
    nockDocs();
    nock(DOCS_ORIGIN).get(SKILLS_INDEX_PATH).times(2).reply(503, 'service unavailable', TEXT);
    await expect(buildCorpus()).rejects.toThrow(/failed to fetch .*index\.json: 503/);
  });

  it('fails the build when the skills index is not JSON', async () => {
    nockDocs();
    nock(DOCS_ORIGIN).get(SKILLS_INDEX_PATH).times(2).reply(200, '<html>soft 404</html>', { 'content-type': 'text/html' });
    await expect(buildCorpus()).rejects.toThrow(/index\.json: 200 .*text\/html/);
  });

  it('fails the build when the skills index lists no skills', async () => {
    nockDocs();
    nockSkills({ [SKILLS_INDEX_PATH]: withIndex(() => []) });
    await expect(buildCorpus()).rejects.toThrow(/lists no skills/);
  });

  it('fails the build when the skills index is malformed JSON', async () => {
    nockDocs();
    nockSkills({ [SKILLS_INDEX_PATH]: recorded(SKILLS_INDEX_PATH).slice(0, -10) });
    await expect(buildCorpus()).rejects.toThrow(/not valid JSON/);
  });

  it('fails the build when a listed skill name is not a slug, before fetching anything for it', async () => {
    nockDocs();
    nockSkills({ [SKILLS_INDEX_PATH]: withIndex((skills) => [...skills, { name: '../../llms-full.txt?', files: ['SKILL.md'] }]) });
    await expect(buildCorpus()).rejects.toThrow(/invalid name/);
  });

  it('fails the build when the index lists a skill twice', async () => {
    nockDocs();
    nockSkills({ [SKILLS_INDEX_PATH]: withIndex((skills) => [...skills, skills[0]]) });
    await expect(buildCorpus()).rejects.toThrow(/twice/);
  });

  it('fails the build when a listed skill has no SKILL.md', async () => {
    nockDocs();
    nockSkills({ [SKILLS_INDEX_PATH]: withIndex((skills) => skills.map((skill, i) => (i === 0 ? { ...skill, files: [] } : skill))) });
    await expect(buildCorpus()).rejects.toThrow(/without a SKILL\.md/);
  });

  it('fails the build when a listed SKILL.md is unreachable', async () => {
    const target = skillPath(recordedNames[0]);
    nockDocs();
    nockSkills({ [target]: null });
    nock(DOCS_ORIGIN).get(target).times(2).reply(404, 'not found', { 'content-type': 'text/html' });
    await expect(buildCorpus()).rejects.toThrow(/failed to fetch .*SKILL\.md: 404/);
  });

  it('fails the build when a SKILL.md names a different skill than the index lists', async () => {
    const [first, second] = recordedNames;
    nockDocs();
    nockSkills({ [skillPath(first)]: recorded(skillPath(second)) });
    await expect(buildCorpus()).rejects.toThrow(new RegExp(`does not name ${first} \\(frontmatter name: ${second}\\)`));
  });

  it('fails the build when a SKILL.md has no frontmatter', async () => {
    const target = skillPath(recordedNames[0]);
    const body = recorded(target).replace(/^---[\s\S]*?\n---\n/, '');
    nockDocs();
    nockSkills({ [target]: body });
    await expect(buildCorpus()).rejects.toThrow(/has no frontmatter/);
  });

  it('fails the build when a SKILL.md has nothing after its frontmatter', async () => {
    const target = skillPath(recordedNames[0]);
    const frontmatter = recorded(target).match(/^---[\s\S]*?\n---\n/)![0];
    nockDocs();
    nockSkills({ [target]: frontmatter });
    await expect(buildCorpus()).rejects.toThrow(/no content after its frontmatter/);
  });
});
