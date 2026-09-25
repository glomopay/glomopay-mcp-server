import { readFileSync } from 'fs';

import { Bm25Index } from '@/shared/search/search.module';

interface IDocChunk {
  title: string;
  url: string;
  section: string;
  sectionDescription: string;
  entryDescription: string;
  heading: string;
  text: string;
}

export interface IDocsResult {
  title: string;
  url: string;
  heading: string;
  anchor: string;
  excerpt: string;
  score: number;
}

interface ICorpusPage {
  title: string;
  url: string;
  section: string;
  sectionDescription: string;
  entryDescription?: string;
  content: string;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'for',
  'in',
  'on',
  'at',
  'is',
  'are',
  'be',
  'with',
  'by',
  'as',
  'it',
  'this',
  'that',
  'from',
  'you',
  'your',
]);
const EXCERPT_LIMIT = 1200;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build the excerpt around the first line that matches a query term, so the cited
// snippet actually contains the match rather than the first N chars of the chunk.
function buildExcerpt(text: string, terms: Set<string>): string {
  const lines = text.split('\n');
  const hit = lines.findIndex((line) => tokenize(line).some((token) => terms.has(token)));
  if (hit < 0) return text.slice(0, EXCERPT_LIMIT).trim();

  let start = hit;
  let end = hit;
  let length = lines[hit].length;
  while (length < EXCERPT_LIMIT && (start > 0 || end < lines.length - 1)) {
    if (start > 0) {
      start -= 1;
      length += lines[start].length + 1;
    }
    if (length < EXCERPT_LIMIT && end < lines.length - 1) {
      end += 1;
      length += lines[end].length + 1;
    }
  }
  return lines
    .slice(start, end + 1)
    .join('\n')
    .trim()
    .slice(0, EXCERPT_LIMIT);
}

function chunkPage(page: ICorpusPage): IDocChunk[] {
  const chunks: IDocChunk[] = [];
  let heading = page.title;
  let buffer: string[] = [];
  const base = {
    title: page.title,
    url: page.url,
    section: page.section,
    sectionDescription: page.sectionDescription,
    entryDescription: page.entryDescription ?? '',
  };

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) chunks.push({ ...base, heading, text });
  };

  for (const line of page.content.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      flush();
      heading = match[1].trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (chunks.length === 0) {
    chunks.push({ ...base, heading: page.title, text: page.content.trim() });
  }
  return chunks;
}

export class DocsIndex {
  private chunks: IDocChunk[];
  private bm25: Bm25Index;

  constructor(chunks: IDocChunk[]) {
    this.chunks = chunks;

    const repeat = (tokens: string[], times: number): string[] => Array.from({ length: times }, () => tokens).flat();
    this.bm25 = new Bm25Index(
      chunks.map((chunk) => [
        ...repeat(tokenize(chunk.title), 3),
        ...repeat(tokenize(chunk.heading), 2),
        ...repeat(tokenize(chunk.entryDescription), 2),
        ...tokenize(`${chunk.section} ${chunk.sectionDescription} ${chunk.text}`),
      ]),
    );
  }

  static fromCorpusFile(filePath: string): DocsIndex {
    const corpus = JSON.parse(readFileSync(filePath, 'utf8')) as ICorpusPage[];
    return new DocsIndex(corpus.flatMap(chunkPage));
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, limit: number): IDocsResult[] {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return [];

    const scores = this.bm25.scores(terms);
    return this.chunks
      .map((chunk, i) => ({ chunk, score: scores[i] }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        title: entry.chunk.title,
        url: entry.chunk.url,
        heading: entry.chunk.heading,
        anchor: `${entry.chunk.url}#${slugify(entry.chunk.heading)}`,
        excerpt: buildExcerpt(entry.chunk.text, terms),
        score: Number(entry.score.toFixed(3)),
      }));
  }
}
