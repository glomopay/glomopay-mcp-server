import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LLMS_URL = process.env.DOCS_LLMS_URL || 'https://docs.glomo.one/llms.txt';
const OUT_PATH = path.resolve(import.meta.dirname, '..', 'dist', 'docs-corpus.json');
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 8;

function parseLlms(text) {
  const entries = [];
  const seen = new Set();
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
      if (!url.endsWith('.md') || url.includes('/api-reference/') || seen.has(url)) continue;
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

async function fetchAll(entries) {
  const out = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        const response = await fetch(entry.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
          console.error(`[fetch-docs] skip ${entry.url} (${response.status})`);
          continue;
        }
        out.push({ ...entry, content: await response.text() });
      } catch (error) {
        console.error(`[fetch-docs] skip ${entry.url}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return out;
}

async function main() {
  console.error(`[fetch-docs] fetching ${LLMS_URL}`);

  const indexResponse = await fetch(LLMS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!indexResponse.ok) {
    throw new Error(`[fetch-docs] fetch failed: ${indexResponse.status} ${indexResponse.statusText}`);
  }

  const entries = parseLlms(await indexResponse.text());
  if (entries.length === 0) {
    throw new Error('[fetch-docs] no documentation entries parsed from llms.txt');
  }

  console.error(`[fetch-docs] fetching ${entries.length} pages`);
  const corpus = await fetchAll(entries);
  if (corpus.length === 0) {
    throw new Error('[fetch-docs] every documentation page failed to fetch');
  }

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(corpus));

  console.error(`[fetch-docs] wrote ${OUT_PATH} (${corpus.length} pages)`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
