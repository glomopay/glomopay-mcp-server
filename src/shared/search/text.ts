export const STOPWORDS = new Set([
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

export function repeat(tokens: string[], times: number): string[] {
  return Array.from({ length: times }, () => tokens).flat();
}
