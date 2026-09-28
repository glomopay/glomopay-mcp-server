export const CLIENT_NAMES = ['claude_code', 'cursor', 'vscode', 'windsurf', 'codex', 'other'] as const;
export type TClientName = (typeof CLIENT_NAMES)[number];

export interface IClientInfo {
  clientName: TClientName;
  clientVersion?: string;
}

// Cursor reports itself as "cursor-vscode", so it is matched before vscode.
const CLIENT_PATTERNS: [RegExp, TClientName][] = [
  [/claude[\s_-]?code/i, 'claude_code'],
  [/cursor/i, 'cursor'],
  [/windsurf/i, 'windsurf'],
  [/codex/i, 'codex'],
  [/vs[\s_-]?code|visual[\s_-]?studio[\s_-]?code/i, 'vscode'],
];

const VERSION_FORMAT = /^\d[0-9A-Za-z.+-]{0,31}$/;

export function normaliseClientName(name: unknown): TClientName {
  if (typeof name !== 'string') return 'other';
  return CLIENT_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other';
}

function normaliseVersion(version: unknown): string | undefined {
  return typeof version === 'string' && VERSION_FORMAT.test(version) ? version : undefined;
}

/** From an MCP initialize request's clientInfo. */
export function clientFromInitialize(clientInfo: unknown): IClientInfo {
  const { name, version } = (clientInfo ?? {}) as { name?: unknown; version?: unknown };
  const clientName = normaliseClientName(name);
  const clientVersion = normaliseVersion(version);
  return clientVersion ? { clientName, clientVersion } : { clientName };
}

/**
 * From a User-Agent header. The transport is stateless, so requests after initialize
 * carry no clientInfo; the first product token that names a known client is used.
 */
export function clientFromUserAgent(userAgent: string | undefined): IClientInfo {
  for (const [, product, version] of (userAgent ?? '').matchAll(/([A-Za-z][\w.-]*)\/(\S+)/g)) {
    const clientName = normaliseClientName(product);
    if (clientName === 'other') continue;
    const clientVersion = normaliseVersion(version);
    return clientVersion ? { clientName, clientVersion } : { clientName };
  }
  return { clientName: normaliseClientName(userAgent) };
}
