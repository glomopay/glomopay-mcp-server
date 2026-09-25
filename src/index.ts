import './instrumentation';

import path from 'path';

import { createApp, flushApps } from '@/core/app/app.module';
import { config } from '@/features/app-config/app-config.module';
import { shutdownTelemetry } from '@/core/telemetry/telemetry.module';
import { logger } from '@/shared/logger/logger.module';

const SHUTDOWN_DEADLINE_MS = 5_000;

(async () => {
  const app = await createApp({
    specPath: path.resolve(__dirname, 'openapi.json'),
    apiHost: config.glomopay.apiHost,
    docsCorpusPath: path.resolve(__dirname, 'docs-corpus.json'),
    authPublicKey: config.auth.mcpPublicKey,
    authAudience: config.auth.mcpAudience,
  });

  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info('glomo MCP server listening', { host: config.http.host, port: config.http.port, path: '/mcp' });
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close();
    const deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref());
    void Promise.race([flushApps().then(() => shutdownTelemetry()), deadline]).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
})();
