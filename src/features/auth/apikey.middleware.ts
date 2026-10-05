import { RequestHandler } from 'express';

import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
  }
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Parses `Authorization: Bearer <mcp-credential>` when present and exposes it to tools as
 * `extra.authInfo.token`. The bearer is the caller's MCP credential, which `CredentialVerifier`
 * checks before any execution call; a secret key is never accepted. It never rejects a request: the
 * discovery tools and `tools/list` are usable without a credential, and the read/write tools
 * fail closed in the dispatcher when no credential is present.
 */
export const apiKeyAuthMiddleware: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : undefined;

  if (token) {
    req.auth = { token, clientId: 'apikey-passthrough', scopes: [] };
  }

  next();
};
