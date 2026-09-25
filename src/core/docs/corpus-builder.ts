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
export const LLMS_URL = `${DOCS_ORIGIN}/llms.txt`;

const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 8;

function isDocsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.host === 'docs.glomo.one';
  } catch {
    return false;
  }
}

export function parseLlms(text: string): ICorpusEntry[] {
  const entries: ICorpusEntry[] = [];
  const seen = new Set<string>();
  let section = '';
  let sectionDescription = '';
  let sawBullet = false;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const header = line.match(/^##\s+(.+)$/);
    if (header) {
      section = header[1].trim();
      sectionDescription = '';
      sawBullet = false;
      continue;
    }

    const bullet = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*:?\s*(.*)$/);
    if (bullet) {
      sawBullet = true;
      const url = bullet[2].trim();
      // Only https docs.glomo.one markdown pages, excluding the api-reference
      // pages (the spec covers those). Skip anything off-host or duplicated.
      if (!isDocsUrl(url) || !url.endsWith('.md') || url.includes('/api-reference/') || seen.has(url)) continue;
      seen.add(url);
      entries.push({ title: bullet[1].trim(), url, section, sectionDescription, entryDescription: (bullet[3] || '').trim() });
      continue;
    }

    if (section && !sawBullet && line.trim() && !line.startsWith('#')) {
      sectionDescription = sectionDescription ? `${sectionDescription} ${line.trim()}` : line.trim();
    }
  }

  return entries;
}

async function fetchDocsPage(url: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && /markdown|text\/plain/.test(contentType)) return response.text();
      if (attempt === 1) {
        throw new Error(`${response.status} ${response.statusText} (${contentType || 'no content-type'})`);
      }
    } catch (error) {
      if (attempt === 1) throw new Error(`[corpus] failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`[corpus] failed to fetch ${url}`);
}

export async function buildCorpus(llmsUrl: string = LLMS_URL): Promise<ICorpusPage[]> {
  if (!isDocsUrl(llmsUrl)) throw new Error(`[corpus] refusing non-docs llms.txt URL: ${llmsUrl}`);

  const indexResponse = await fetch(llmsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!indexResponse.ok) throw new Error(`[corpus] llms.txt fetch failed: ${indexResponse.status} ${indexResponse.statusText}`);

  const entries = parseLlms(await indexResponse.text());
  if (entries.length === 0) throw new Error('[corpus] no documentation entries parsed from llms.txt');

  const pages: ICorpusPage[] = [];
  for (let start = 0; start < entries.length; start += CONCURRENCY) {
    const batch = entries.slice(start, start + CONCURRENCY);
    const contents = await Promise.all(batch.map((entry) => fetchDocsPage(entry.url)));
    batch.forEach((entry, i) => pages.push({ ...entry, content: contents[i] }));
  }

  return pages;
}
