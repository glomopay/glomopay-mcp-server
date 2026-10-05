import express, { Express, RequestHandler } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { MCPServer } from '@/core/mcp-server/mcp-server.module';
import type { IHttpMetrics } from '@/core/telemetry/telemetry.module';
import { apiKeyAuthMiddleware } from '@/features/auth/auth.module';

import { clientIpDiagnostic } from './client-ip-diagnostic';
import { createRejecter, JSON_RPC_TRANSPORT_ERROR, jsonRpcErrorHandler, sendJsonRpcError } from './json-rpc-errors';
import { executionRateLimit, overallRateLimit, type IRateLimitConfig } from './rate-limit';
import { BODY_LIMIT_KB, checkEnvelope, parseJsonBody } from './request-envelope';

const METHOD_NOT_ALLOWED_STATELESS = 'Method not allowed: this server runs stateless Streamable HTTP and only supports POST /mcp.';

export interface IHttpServerOptions {
  metrics: IHttpMetrics;
  /** Proxy hops in front of the app (Express `trust proxy`); 0 trusts none, so X-Forwarded-For is ignored. */
  trustProxyHops: number;
  rateLimit: IRateLimitConfig;
  /** Most JSON-RPC messages one POST may carry. */
  maxBatchMessages: number;
  /** Log the one-shot client IP diagnostic (see `client-ip-diagnostic.ts`). */
  clientIpDiagnostic: boolean;
}

const health: RequestHandler = (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok' });
};

export function createHttpServer(mcpServer: MCPServer, options: IHttpServerOptions): Express {
  const reject = createRejecter(options.metrics);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxyHops > 0 ? options.trustProxyHops : false);

  // Liveness only: no docs corpus, spec, upstream call or MCP server, and never rate-limited.
  app.get('/healthz', health);

  if (options.clientIpDiagnostic) app.use('/mcp', clientIpDiagnostic(options.trustProxyHops));
  app.use('/mcp', overallRateLimit(options.rateLimit, reject));

  app.post(
    '/mcp',
    ...parseJsonBody(reject),
    checkEnvelope(reject, options.maxBatchMessages),
    apiKeyAuthMiddleware,
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
