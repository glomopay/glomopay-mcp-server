import { Bm25Index, STOPWORDS, repeat } from '@/shared/search/search.module';

import type { IFlow, IFlowGuide } from './flow-guide';

export interface IFlowCandidate {
  id: string;
  title: string;
  summary: string;
  score: number;
}

function singular(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2 && !STOPWORDS.has(token)).map(singular);
}

export class FlowIndex {
  private flows: IFlow[];
  private bm25: Bm25Index;

  constructor(guide: IFlowGuide) {
    this.flows = guide.flows;
    this.bm25 = new Bm25Index(
      this.flows.map((flow) => [
        ...repeat(tokenize(flow.title), 3),
        ...repeat(tokenize(flow.variants.map((variant) => variant.name).join(' ')), 2),
        ...tokenize(flow.summary),
        ...tokenize(flow.variants.map((variant) => variant.guide.title).join(' ')),
      ]),
    );
  }

  candidates(goal: string, limit: number): IFlowCandidate[] {
    const terms = new Set(tokenize(goal));
    if (terms.size === 0) return [];

    const scores = this.bm25.scores(terms);
    return this.flows
      .map((flow, i) => ({ flow, score: scores[i] }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ flow, score }) => ({ id: flow.id, title: flow.title, summary: flow.summary, score: Number(score.toFixed(3)) }));
  }
}
