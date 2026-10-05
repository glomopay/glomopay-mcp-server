export interface ICorpusEntry {
  title: string;
  url: string;
  section: string;
  sectionDescription: string;
  entryDescription: string;
}

export interface ICorpusPage extends ICorpusEntry {
  content: string;
}

export const DOCS_ORIGIN = 'https://docs.glomo.one';
export const LLMS_FULL_URL = `${DOCS_ORIGIN}/llms-full.txt`;
export const LLMS_INDEX_URL = `${DOCS_ORIGIN}/llms.txt`;
export const SKILLS_INDEX_URL = `${DOCS_ORIGIN}/.well-known/skills/index.json`;
export const SKILLS_SECTION = 'Skills';

const SKILL_FILE = 'SKILL.md';
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FETCH_TIMEOUT_MS = 15000;

function isDocsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.host === 'docs.glomo.one';
  } catch {
    return false;
  }
}

function titleOf(content: string, url: string): string {
  const heading = content.split('\n').find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, '').trim();
  const slug = url.split('/').filter(Boolean).pop() ?? url;
  return slug.replace(/[-_]+/g, ' ');
}

// llms-full.txt is the full text of every page in one file. Each page starts with
// a `Source:` line and a `Section:` line, then its markdown body, and runs until
// the next `Source:` line. Page bodies contain `---` rules and tables, so the only
// safe delimiter is the `Source:` line itself.
export function parseLlmsFull(text: string): ICorpusPage[] {
  const pages: ICorpusPage[] = [];
  const seen = new Set<string>();
  let url: string | null = null;
  let section = '';
  let body: string[] = [];

  const flush = () => {
    if (!url) return;
    const content = body.join('\n').trim();
    if (content) pages.push({ title: titleOf(content, url), url, section, sectionDescription: '', entryDescription: '', content });
  };

  for (const raw of text.split('\n')) {
    const source = raw.match(/^Source:\s+(\S+)\s*$/);
    if (source) {
      flush();
      url = source[1];
      if (!isDocsUrl(url)) throw new Error(`[corpus] llms-full.txt has a non-docs Source URL: ${url}`);
      if (seen.has(url)) throw new Error(`[corpus] llms-full.txt has a duplicate Source URL: ${url}`);
      seen.add(url);
      section = '';
      body = [];
      continue;
    }
    if (!url) continue;

    const sectionLine = raw.match(/^Section:\s+(.+?)\s*$/);
    if (sectionLine && !section && body.length === 0) {
      section = sectionLine[1].trim();
      continue;
    }
    body.push(raw);
  }
  flush();

  return pages;
}

// llms.txt is the human index: markdown bullets linking each page as `.md`. It is
// the authority on which pages exist, so the corpus must match it exactly. The
// api-reference pages are generated from the OpenAPI spec and are excluded here,
// as they are from llms-full.txt.
export function parseLlmsIndex(text: string): string[] {
  const urls = new Set<string>();
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*-\s*\[[^\]]+\]\(([^)]+)\)/);
    if (!bullet) continue;
    const url = bullet[1].replace(/\.md$/, '');
    if (isDocsUrl(url) && !url.includes('/api-reference/')) urls.add(url);
  }
  return [...urls].sort();
}

function assertCorpusMatchesIndex(pages: ICorpusPage[], indexUrls: string[]): void {
  const built = new Set(pages.map((page) => page.url));
  const listed = new Set(indexUrls);
  const missing = indexUrls.filter((url) => !built.has(url));
  const unlisted = pages.map((page) => page.url).filter((url) => !listed.has(url));
  if (missing.length || unlisted.length) {
    throw new Error(
      `[corpus] llms-full.txt does not match llms.txt: ${missing.length} listed page(s) missing, ${unlisted.length} unlisted page(s) present. ` +
        `missing=[${missing.join(', ')}] unlisted=[${unlisted.join(', ')}]`,
    );
  }
}

const TEXT_CONTENT = /markdown|text\/plain/;
const JSON_CONTENT = /application\/json/;

async function fetchDocs(url: string, accept: RegExp = TEXT_CONTENT): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Refuse redirects outright, so a request never leaves the pinned docs URL.
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && accept.test(contentType)) return response.text();
      if (attempt === 1) throw new Error(`${response.status} ${response.statusText} (${contentType || 'no content-type'})`);
    } catch (error) {
      if (attempt === 1) throw new Error(`[corpus] failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`[corpus] failed to fetch ${url}`);
}

interface ISkillListing {
  name: string;
  url: string;
}

// index.json is the published skills catalogue: `{ skills: [{ name, files }] }`.
// Each skill's SKILL.md sits next to it at `<name>/SKILL.md`. Names are checked as
// slugs before they become a path, so a listing can never point outside the skills
// directory or off the docs host.
function parseSkillsIndex(text: string, indexUrl: string): ISkillListing[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`[corpus] ${indexUrl} is not valid JSON`);
  }
  const skills = (parsed as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills) || skills.length === 0) throw new Error(`[corpus] ${indexUrl} lists no skills`);

  const seen = new Set<string>();
  return skills.map((entry: { name?: unknown; files?: unknown } | null) => {
    const name = entry?.name;
    if (typeof name !== 'string' || !SKILL_NAME.test(name))
      throw new Error(`[corpus] ${indexUrl} lists a skill with an invalid name: ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`[corpus] ${indexUrl} lists ${name} twice`);
    seen.add(name);
    if (!Array.isArray(entry?.files) || !entry.files.includes(SKILL_FILE))
      throw new Error(`[corpus] ${indexUrl} lists ${name} without a ${SKILL_FILE}`);
    return { name, url: new URL(`${name}/${SKILL_FILE}`, indexUrl).toString() };
  });
}

// A SKILL.md opens with YAML frontmatter between `---` lines (`name`, `description`,
// `metadata.version`), then the markdown body. The frontmatter is for skill loaders,
// so only the body is indexed. The frontmatter `name` must be the listed name, or
// the catalogue and the file disagree about which skill this is.
function parseSkillFile(text: string, skill: ISkillListing): ICorpusPage {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const end = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1;
  if (end < 0) throw new Error(`[corpus] ${skill.url} has no frontmatter`);

  const declared = lines
    .slice(1, end)
    .map((line) => line.match(/^name:\s*(["']?)(.+?)\1\s*$/))
    .find(Boolean)?.[2];
  if (declared !== skill.name) throw new Error(`[corpus] ${skill.url} does not name ${skill.name} (frontmatter name: ${declared ?? 'missing'})`);

  const content = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (!content) throw new Error(`[corpus] ${skill.url} has no content after its frontmatter`);

  return { title: skillTitle(skill.name), url: skill.url, section: SKILLS_SECTION, sectionDescription: '', entryDescription: '', content };
}

// glomo-payouts -> "Glomo payouts (agent skill)". The URL already identifies the skill exactly.
function skillTitle(name: string): string {
  const topic = name.replace(/^glomo-/, '').replace(/-/g, ' ');
  return `Glomo ${topic} (agent skill)`;
}

async function buildSkillPages(indexUrl: string): Promise<ICorpusPage[]> {
  const skills = parseSkillsIndex(await fetchDocs(indexUrl, JSON_CONTENT), indexUrl);
  return Promise.all(skills.map(async (skill) => parseSkillFile(await fetchDocs(skill.url), skill)));
}

// The docs pages are checked against llms.txt on their own. The skills are added
// after that check as their own pages, so they never count towards it.
export async function buildCorpus(
  fullUrl: string = LLMS_FULL_URL,
  indexUrl: string = LLMS_INDEX_URL,
  skillsIndexUrl: string = SKILLS_INDEX_URL,
): Promise<ICorpusPage[]> {
  if (!isDocsUrl(fullUrl)) throw new Error(`[corpus] refusing non-docs llms-full.txt URL: ${fullUrl}`);
  if (!isDocsUrl(indexUrl)) throw new Error(`[corpus] refusing non-docs llms.txt URL: ${indexUrl}`);
  if (!isDocsUrl(skillsIndexUrl)) throw new Error(`[corpus] refusing non-docs skills index URL: ${skillsIndexUrl}`);

  const [full, index] = await Promise.all([fetchDocs(fullUrl), fetchDocs(indexUrl)]);
  const pages = parseLlmsFull(full);
  assertCorpusMatchesIndex(pages, parseLlmsIndex(index));
  if (pages.length === 0) throw new Error('[corpus] no documentation pages parsed from llms-full.txt');

  return [...pages, ...(await buildSkillPages(skillsIndexUrl))];
}
