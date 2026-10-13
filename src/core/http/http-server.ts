import express, { Express, RequestHandler } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildServerCard, MCPServer, SERVER_CARD_MEDIA_TYPE } from '@/core/mcp-server/mcp-server.module';
import type { IHttpMetrics } from '@/core/telemetry/telemetry.module';
import { apiKeyAuthMiddleware, type CredentialVerifier } from '@/features/auth/auth.module';

import { clientIpDiagnostic } from './client-ip-diagnostic';
import { createRejecter, JSON_RPC_TRANSPORT_ERROR, jsonRpcErrorHandler, sendJsonRpcError } from './json-rpc-errors';
import { callerRateLimit, executionRateLimit, floodRateLimit, identifyCaller, type IRateLimitConfig } from './rate-limit';
import { BODY_LIMIT_KB, checkEnvelope, parseJsonBody } from './request-envelope';

const METHOD_NOT_ALLOWED_STATELESS = 'Method not allowed: this server runs stateless Streamable HTTP and only supports POST /mcp.';

export interface IHttpServerOptions {
  metrics: IHttpMetrics;
  /** The dispatcher's verifier: a verified merchant is rate-limited as itself, not by address. */
  verifier: CredentialVerifier;
  /** Proxy hops in front of the app (Express `trust proxy`); 0 trusts none, so X-Forwarded-For is ignored. */
  trustProxyHops: number;
  rateLimit: IRateLimitConfig;
  /** Log the one-shot client IP diagnostic (see `client-ip-diagnostic.ts`). */
  clientIpDiagnostic: boolean;
}

const health: RequestHandler = (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok' });
};

/** Serialised once: the card only changes with a deploy. */
const SERVER_CARD_BODY = JSON.stringify(buildServerCard());

/** Open CORS, as SEP-2127 allows for cards: a browser-based client discovers the server before it has any credential. */
const serverCard: RequestHandler = (_req, res) => {
  res
    .set({ 'Content-Type': SERVER_CARD_MEDIA_TYPE, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' })
    .send(SERVER_CARD_BODY);
};

export function createHttpServer(mcpServer: MCPServer, options: IHttpServerOptions): Express {
  const reject = createRejecter(options.metrics);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxyHops > 0 ? options.trustProxyHops : false);

  // Liveness only: no docs corpus, spec, upstream call or MCP server, and never rate-limited.
  app.get('/healthz', health);

  if (options.clientIpDiagnostic) app.use('/mcp', clientIpDiagnostic(options.trustProxyHops));
  app.use('/mcp', floodRateLimit(options.rateLimit, reject));

  // Pre-connection discovery (SEP-2127): no auth, but behind the flood guard like everything under /mcp.
  app.get('/mcp/server-card', serverCard);

  app.post(
    '/mcp',
    ...parseJsonBody(reject),
    checkEnvelope(reject),
    apiKeyAuthMiddleware,
    identifyCaller(options.verifier),
    callerRateLimit(options.rateLimit, reject),
    executionRateLimit(options.rateLimit, reject),
    async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  const methodNotAllowed: RequestHandler = (_req, res) => sendJsonRpcError(res, 405, JSON_RPC_TRANSPORT_ERROR, METHOD_NOT_ALLOWED_STATELESS);
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.use((_req, res) => sendJsonRpcError(res, 404, JSON_RPC_TRANSPORT_ERROR, 'Not Found'));
  app.use(jsonRpcErrorHandler(reject, BODY_LIMIT_KB));

  return app;
}
