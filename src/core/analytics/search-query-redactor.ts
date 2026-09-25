export const SEARCH_QUERY_MAX_LENGTH = 200;

type TRule = [pattern: RegExp, replace: string | ((match: string) => string)];

/** Separators allowed between digit groups: up to three of space, dot, slash, underscore, dash. */
const SEP = '[ ./_-]{0,3}';

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

// Order matters: token-shaped values first (so a secret is masked whole, not in part),
// then the digit patterns from longest to shortest, so a card number is not
// half-masked as a phone number. The last rule masks any digit run still long
// enough to identify someone.
const RULES: TRule[] = [
  [/eyJ[A-Za-z0-9_-]+\s*\.\s*[A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)?/g, '[jwt]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/[\w.-]+@[a-z]{2,}/gi, '[upi]'],
  [/\b(?:live|test)[_-][A-Za-z0-9]{12,}/gi, '[key]'],
  [/(?<![A-Za-z0-9])[A-Fa-f0-9]{20,}(?![A-Za-z0-9])/g, '[key]'],
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{20,}={0,2}/g, '[key]'],
  [/[A-Za-z]{5}\d{4}[A-Za-z]/gi, '[pan]'],
  [new RegExp(`(?<!\\w)\\d(?:${SEP}\\d){12,18}(?!\\w)`, 'g'), '[card]'],
  [new RegExp(`(?<!\\w)\\d{4}${SEP}\\d{4}${SEP}\\d{4}(?!\\w)`, 'g'), '[aadhaar]'],
  [
    new RegExp(`(?<![\\w+])(?:\\+\\d{1,3}${SEP})?(?:\\(\\d{1,5}\\)${SEP})?\\d(?:${SEP}\\d){6,13}(?!\\w)`, 'g'),
    (match) => (digitCount(match) >= 10 ? '[phone]' : match),
  ],
  [/\d(?:[\s./_-]*\d){8,}/g, '[number]'],
];

/** Unicode compatibility forms folded (full-width digits, NBSP) and whitespace runs collapsed. */
function normalise(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ');
}

/**
 * Masks personal data and credentials in free-text search input, then trims it and
 * caps it at SEARCH_QUERY_MAX_LENGTH characters. Masking runs before the cap.
 */
export function redactSearchQuery(text: string): string {
  let redacted = normalise(text);
  for (const [pattern, replace] of RULES) {
    redacted = typeof replace === 'string' ? redacted.replace(pattern, replace) : redacted.replace(pattern, replace);
  }
  return Array.from(redacted.trim()).slice(0, SEARCH_QUERY_MAX_LENGTH).join('').trim();
}
