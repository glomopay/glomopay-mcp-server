const K1 = 1.5;
const B = 0.75;

export class Bm25Index {
  private termFreqs: Map<string, number>[];
  private docLengths: number[];
  private idf: Map<string, number>;
  private avgdl: number;

  constructor(documents: string[][]) {
    this.docLengths = documents.map((tokens) => tokens.length);
    this.avgdl = this.docLengths.reduce((sum, len) => sum + len, 0) / (this.docLengths.length || 1) || 1;

    this.termFreqs = documents.map((tokens) => {
      const freq = new Map<string, number>();
      for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
      return freq;
    });

    const docFreq = new Map<string, number>();
    for (const freq of this.termFreqs) {
      for (const term of freq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    const total = documents.length || 1;
    this.idf = new Map();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
    }
  }

  scores(terms: Iterable<string>): number[] {
    const unique = new Set(terms);
    return this.termFreqs.map((freq, i) => {
      let score = 0;
      for (const term of unique) {
        const tf = freq.get(term);
        if (!tf) continue;
        const idf = this.idf.get(term) ?? 0;
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * this.docLengths[i]) / this.avgdl));
      }
      return score;
    });
  }
}
