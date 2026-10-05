import type { RequestHandler } from 'express';

import { logger } from '@/shared/logger/logger.module';

import { AddressRanges, NON_PUBLIC_RANGES, normalizeAddress } from './client-address';

/** RFC 5737 documentation range (TEST-NET-3): never a real client, so it marks the entry the tester forged. */
const FORGED_MARKER = new AddressRanges(['203.0.113.0/24']);

/** Enough for a check per hostname, and bounded however many marked requests arrive while the flag is on. */
const MAX_LINES = 10;

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

function indexFromRight(entries: readonly string[], position: number): number | undefined {
  return position === -1 ? undefined : entries.length - 1 - position;
}

/**
 * Behind CLIENT_IP_DIAGNOSTIC, checks that TRUST_PROXY_HOPS resolves the real client. A tester sends a
 * request carrying a forged `X-Forwarded-For: 203.0.113.7`; every proxy in front of the app appends to
 * the right of it, so its position counted from the right is the hop count to trust. One line is logged
 * per marked request (at most MAX_LINES per process), with positions and booleans only: never an
 * address, a header value or a credential.
 */
export function clientIpDiagnostic(trustProxyHops: number): RequestHandler {
  let lines = 0;
  return (req, _res, next) => {
    const entries = (header(req.headers['x-forwarded-for']) ?? '')
      .split(',')
      .map((entry) => normalizeAddress(entry.trim()))
      .filter((entry): entry is string => Boolean(entry));
    const marker = entries.findLastIndex((entry) => FORGED_MARKER.has(entry));

    if (marker !== -1 && lines < MAX_LINES) {
      lines += 1;
      const requestIp = normalizeAddress(req.ip);
      const fromRight = indexFromRight(entries, requestIp ? entries.lastIndexOf(requestIp) : -1);
      const markerFromRight = indexFromRight(entries, marker)!;
      const trueClientIp = normalizeAddress(header(req.headers['true-client-ip'])?.trim());

      logger.info('client ip diagnostic', {
        component: 'http',
        trustProxyHops,
        // The Host header, not req.hostname: with proxies trusted, Express would read X-Forwarded-Host.
        onRenderSubdomain: (req.headers.host ?? '').split(':')[0].toLowerCase().endsWith('.onrender.com'),
        xffEntries: entries.length,
        markerIndexFromRight: markerFromRight,
        // The real client is the entry just right of the marker, so trusting this many hops reaches it.
        suggestedTrustProxyHops: markerFromRight,
        reqIpFromSocket: fromRight === undefined,
        reqIpIndexFromRight: fromRight,
        reqIpIsMarker: FORGED_MARKER.has(requestIp),
        reqIpIsPrivate: NON_PUBLIC_RANGES.has(requestIp),
        hasTrueClientIp: Boolean(trueClientIp),
        reqIpEqualsTrueClientIp: Boolean(trueClientIp) && requestIp === trueClientIp,
      });
    }
    next();
  };
}
