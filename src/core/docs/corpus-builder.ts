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
  let url: string | null = null;
  let section = '';
  let body: string[] = [];

  const flush = () => {
    if (!url || !isDocsUrl(url)) return;
    const content = body.join('\n').trim();
    if (content) pages.push({ title: titleOf(content, url), url, section, sectionDescription: '', entryDescription: '', content });
  };

  for (const raw of text.split('\n')) {
    const source = raw.match(/^Source:\s+(\S+)\s*$/);
    if (source) {
      flush();
      url = source[1];
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

async function fetchDocs(url: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && /markdown|text\/plain/.test(contentType)) return response.text();
      if (attempt === 1) throw new Error(`${response.status} ${response.statusText} (${contentType || 'no content-type'})`);
    } catch (error) {
      if (attempt === 1) throw new Error(`[corpus] failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`[corpus] failed to fetch ${url}`);
}

export async function buildCorpus(url: string = LLMS_FULL_URL): Promise<ICorpusPage[]> {
  if (!isDocsUrl(url)) throw new Error(`[corpus] refusing non-docs llms-full.txt URL: ${url}`);

  const pages = parseLlmsFull(await fetchDocs(url));
  if (pages.length === 0) throw new Error('[corpus] no documentation pages parsed from llms-full.txt');

  return pages;
}
