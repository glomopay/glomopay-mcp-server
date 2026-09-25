export const SEARCH_QUERY_MAX_LENGTH = 200;

type TRule = [pattern: RegExp, replace: string | ((match: string) => string)];

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

// Order matters: token-shaped values first, then the digit patterns from longest to
// shortest, so a card number is not half-masked as a phone number.
const RULES: TRule[] = [
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[jwt]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?<![A-Za-z0-9])(?:live|test)_(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}/g, '[key]'],
  [/(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g, '[key]'],
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g, '[key]'],
  [/(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g, '[card]'],
  [/(?<!\w)\d{4} ?\d{4} ?\d{4}(?!\w)/g, '[aadhaar]'],
  [/(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,5}\)[ .-]?)?\d(?:[ .-]?\d){6,13}(?!\w)/g, (match) => (digitCount(match) >= 10 ? '[phone]' : match)],
  [/(?<![A-Za-z0-9])[A-Za-z]{5}\d{4}[A-Za-z](?![A-Za-z0-9])/g, '[pan]'],
  [/\d{9,}/g, '[number]'],
];

/**
 * Masks personal data and credentials in free-text search input, then trims it and
 * caps it at SEARCH_QUERY_MAX_LENGTH characters.
 */
export function redactSearchQuery(text: string): string {
  let redacted = text;
  for (const [pattern, replace] of RULES) {
    redacted = typeof replace === 'string' ? redacted.replace(pattern, replace) : redacted.replace(pattern, replace);
  }
  return Array.from(redacted.trim()).slice(0, SEARCH_QUERY_MAX_LENGTH).join('').trim();
}
