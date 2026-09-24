import { readFileSync } from 'fs';

interface IDocChunk {
  title: string;
  url: string;
  section: string;
  heading: string;
  text: string;
}

export interface IDocsResult {
  title: string;
  url: string;
  heading: string;
  excerpt: string;
  score: number;
}

interface ICorpusPage {
  title: string;
  url: string;
  section: string;
  sectionDescription: string;
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
const K1 = 1.5;
const B = 0.75;
const EXCERPT_LIMIT = 1200;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function chunkPage(page: ICorpusPage): IDocChunk[] {
  const chunks: IDocChunk[] = [];
  let heading = page.title;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) chunks.push({ title: page.title, url: page.url, section: page.section, heading, text });
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
    chunks.push({ title: page.title, url: page.url, section: page.section, heading: page.title, text: page.content.trim() });
  }
  return chunks;
}

export class DocsIndex {
  private chunks: IDocChunk[];
  private termFreqs: Map<string, number>[];
  private docLengths: number[];
  private idf: Map<string, number>;
  private avgdl: number;

  constructor(chunks: IDocChunk[]) {
    this.chunks = chunks;

    const repeat = (tokens: string[], times: number): string[] => Array.from({ length: times }, () => tokens).flat();
    const docTokens = chunks.map((chunk) => [
      ...repeat(tokenize(chunk.title), 3),
      ...repeat(tokenize(chunk.heading), 2),
      ...tokenize(`${chunk.section} ${chunk.text}`),
    ]);
    this.docLengths = docTokens.map((tokens) => tokens.length);
    this.avgdl = this.docLengths.reduce((sum, len) => sum + len, 0) / (this.docLengths.length || 1) || 1;

    this.termFreqs = docTokens.map((tokens) => {
      const freq = new Map<string, number>();
      for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
      return freq;
    });

    const docFreq = new Map<string, number>();
    for (const freq of this.termFreqs) {
      for (const term of freq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    const total = chunks.length || 1;
    this.idf = new Map();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
    }
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

    const scored = this.chunks.map((chunk, i) => {
      let score = 0;
      for (const term of terms) {
        const freq = this.termFreqs[i].get(term);
        if (!freq) continue;
        const idf = this.idf.get(term) ?? 0;
        score += (idf * (freq * (K1 + 1))) / (freq + K1 * (1 - B + (B * this.docLengths[i]) / this.avgdl));
      }
      return { chunk, score };
    });

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        title: entry.chunk.title,
        url: entry.chunk.url,
        heading: entry.chunk.heading,
        excerpt: entry.chunk.text.slice(0, EXCERPT_LIMIT),
        score: Number(entry.score.toFixed(3)),
      }));
  }
}
