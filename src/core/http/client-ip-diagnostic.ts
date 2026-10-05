import type { RequestHandler } from 'express';

import { logger } from '@/shared/logger/logger.module';

import { NON_PUBLIC_RANGES, normalizeAddress } from './client-address';

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * Behind CLIENT_IP_DIAGNOSTIC, logs one line for the first request after boot that shows whether
 * `trust proxy` resolves the real client. It logs positions and booleans only: never an address,
 * a header value or a credential.
 *
 * `True-Client-IP` is set by the hosting edge; its position counted from the right of
 * X-Forwarded-For, plus one for the socket hop, is the hop count TRUST_PROXY_HOPS should hold.
 */
export function clientIpDiagnostic(trustProxyHops: number): RequestHandler {
  let logged = false;
  return (req, _res, next) => {
    if (!logged) {
      logged = true;
      const entries = (header(req.headers['x-forwarded-for']) ?? '')
        .split(',')
        .map((entry) => normalizeAddress(entry.trim()))
        .filter((entry): entry is string => Boolean(entry));
      const trueClientIp = normalizeAddress(header(req.headers['true-client-ip'])?.trim());
      const position = trueClientIp ? entries.lastIndexOf(trueClientIp) : -1;
      const indexFromRight = position === -1 ? undefined : entries.length - 1 - position;
      const requestIp = normalizeAddress(req.ip);

      logger.info('client ip diagnostic', {
        component: 'http',
        trustProxyHops,
        xffEntries: entries.length,
        hasTrueClientIp: Boolean(trueClientIp),
        trueClientIpIndexFromRight: indexFromRight,
        suggestedTrustProxyHops: indexFromRight === undefined ? undefined : indexFromRight + 1,
        reqIpEqualsTrueClientIp: Boolean(trueClientIp) && requestIp === trueClientIp,
        reqIpIsPrivate: NON_PUBLIC_RANGES.has(requestIp),
      });
    }
    next();
  };
}
