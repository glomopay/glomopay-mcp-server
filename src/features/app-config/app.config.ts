export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const MAX_TRUST_PROXY_HOPS = 5;

/**
 * Anthropic's published egress ranges for MCP connector calls from claude.ai and Claude Desktop,
 * which many users share: https://platform.claude.com/docs/en/api/ip-addresses
 */
export const ANTHROPIC_EGRESS_CIDRS = ['160.79.104.0/21', '2607:6bc0::/48'] as const;

export const RATE_LIMIT_DEFAULTS = {
  floodPerMinute: 1200,
  perMinute: 300,
  merchantPerMinute: 600,
  executionPerMinute: 60,
  sharedEgressPerMinute: 3000,
} as const;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveInteger(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new ConfigError(`${name} must be a positive integer`);
  return Number(value);
}

/**
 * Hops between the client and this process that may set X-Forwarded-For (Express `trust proxy`).
 * Unset means 0: no proxy is trusted. On Render, where a proxy always sits in front, it must be set,
 * so a missing value fails boot rather than keying every client on the proxy's address.
 */
function trustProxyHops(): number {
  const value = env('TRUST_PROXY_HOPS');
  if (value === undefined) {
    if (process.env.RENDER === 'true') throw new ConfigError('TRUST_PROXY_HOPS must be set on Render');
    return 0;
  }
  if (!/^\d+$/.test(value) || Number(value) > MAX_TRUST_PROXY_HOPS) {
    throw new ConfigError(`TRUST_PROXY_HOPS must be an integer from 0 to ${MAX_TRUST_PROXY_HOPS}`);
  }
  return Number(value);
}

/** Unset keeps the default ranges; an empty value turns the shared-egress budget off. */
function sharedEgressCidrs(): readonly string[] {
  const raw = process.env.RATE_LIMIT_SHARED_EGRESS_CIDRS;
  if (raw === undefined) return ANTHROPIC_EGRESS_CIDRS;
  return raw
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
}

export const config = {
  glomopay: {
    apiHost: process.env.API_HOST,
  },
  // Read when the app is created, not at import, so each app instance sees the current env
  // and a bad value fails app creation.
  http: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || '127.0.0.1',
    get trustProxyHops(): number {
      return trustProxyHops();
    },
    get rateLimit() {
      return {
        floodPerMinute: positiveInteger('RATE_LIMIT_FLOOD_PER_MINUTE', RATE_LIMIT_DEFAULTS.floodPerMinute),
        perMinute: positiveInteger('RATE_LIMIT_PER_MINUTE', RATE_LIMIT_DEFAULTS.perMinute),
        merchantPerMinute: positiveInteger('RATE_LIMIT_MERCHANT_PER_MINUTE', RATE_LIMIT_DEFAULTS.merchantPerMinute),
        executionPerMinute: positiveInteger('RATE_LIMIT_EXECUTION_PER_MINUTE', RATE_LIMIT_DEFAULTS.executionPerMinute),
        sharedEgressCidrs: sharedEgressCidrs(),
        sharedEgressPerMinute: positiveInteger('RATE_LIMIT_SHARED_EGRESS_PER_MINUTE', RATE_LIMIT_DEFAULTS.sharedEgressPerMinute),
      };
    },
    get clientIpDiagnostic(): boolean {
      return env('CLIENT_IP_DIAGNOSTIC') === '1';
    },
  },
  analytics: {
    get mixpanelToken(): string | undefined {
      return process.env.MIXPANEL_TOKEN || undefined;
    },
    get mixpanelHost(): string | undefined {
      return process.env.MIXPANEL_HOST || undefined;
    },
  },
  auth: {
    mcpPublicKey: process.env.GLOMO_MCP_PUBLIC_KEY,
    mcpAudience: process.env.GLOMO_MCP_AUDIENCE,
  },
};
