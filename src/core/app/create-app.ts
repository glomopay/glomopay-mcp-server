import type { Express } from 'express';

import { MCPServer } from '@/core/mcp-server/mcp-server.module';
import { createHttpServer } from '@/core/http/http-server.module';
import { Dispatcher, loadSpecDocument, buildSpecIndex } from '@/core/dispatcher/dispatcher.module';
import { buildCatalog } from '@/core/catalog/catalog.module';
import { executionAllowlist } from '@/features/allowlist/allowlist.module';
import { CredentialVerifier } from '@/features/auth/auth.module';
import { ApiReadTool, ApiWriteTool } from '@/features/api-execution/api-execution.module';
import { ApiSearchTool, ApiDetailsTool } from '@/features/api-discovery/api-discovery.module';
import { SampleRequestTool } from '@/features/sample-request/sample-request.module';
import { ImplementationPlannerTool } from '@/features/implementation-planner/implementation-planner.module';
import { DocsIndex } from '@/core/docs/docs.module';
import { DocsSearchTool } from '@/features/docs-search/docs-search.module';
import { ApiClient } from '@/shared/api-client/api-client.module';
import { logger } from '@/shared/logger/logger.module';
import { packageVersion } from '@/shared/package-info/package-info.module';
import { createAnalytics, type IAnalytics } from '@/core/analytics/analytics.module';
import { ToolCallObserver, createToolMetrics } from '@/core/telemetry/telemetry.module';
import { config } from '@/features/app-config/app-config.module';

export interface ICreateAppOptions {
  specPath: string;
  apiHost?: string;
  docsCorpusPath?: string;
  authPublicKey?: string;
  authAudience?: string;
  /** How long analytics events wait to be batched. */
  analyticsFlushIntervalMs?: number;
  /** Upper bound on one analytics request. */
  analyticsTimeoutMs?: number;
  /** Upper bound on a downstream glomo API call. */
  downstreamTimeoutMs?: number;
}

const DEFAULT_DOWNSTREAM_TIMEOUT_MS = 30_000;

const shutdownHooks: (() => Promise<void>)[] = [];

/** Delivers whatever the apps created so far still hold (queued analytics events). */
export async function flushApps(): Promise<void> {
  await Promise.all(shutdownHooks.map((hook) => hook().catch(() => undefined)));
}

function createObserver(
  verifier: CredentialVerifier,
  analyticsFlushIntervalMs: number | undefined,
  analyticsTimeoutMs: number | undefined,
): { observer: ToolCallObserver; analytics: IAnalytics } {
  const metrics = createToolMetrics();
  const analytics = createAnalytics({
    token: config.analytics.mixpanelToken,
    host: config.analytics.mixpanelHost,
    sdkVersion: packageVersion,
    flushIntervalMs: analyticsFlushIntervalMs,
    requestTimeoutMs: analyticsTimeoutMs,
    onDropped: (count) => metrics.analyticsDropped.add(count),
  });
  return { observer: new ToolCallObserver({ analytics, metrics, verifier }), analytics };
}

export async function createApp({
  specPath,
  apiHost,
  docsCorpusPath,
  authPublicKey,
  authAudience,
  analyticsFlushIntervalMs,
  analyticsTimeoutMs,
  downstreamTimeoutMs = DEFAULT_DOWNSTREAM_TIMEOUT_MS,
}: ICreateAppOptions): Promise<Express> {
  const apiClient = new ApiClient({ baseURL: apiHost, timeout: downstreamTimeoutMs });
  const verifier = new CredentialVerifier({ publicKeyPem: authPublicKey, audience: authAudience });
  const parsedSpec = await loadSpecDocument(specPath);
  const specIndex = buildSpecIndex(parsedSpec);

  const allowedOperationIds = [...executionAllowlist].filter((operationId) => {
    if (specIndex.has(operationId)) return true;
    logger.warn('allowlisted operationId is not present in the fetched spec', { component: 'allowlist', operationId });
    return false;
  });
  const readOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method === 'GET');
  const writeOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method !== 'GET');

  const dispatcher = new Dispatcher(specIndex, executionAllowlist, apiClient, verifier);
  const catalog = buildCatalog(parsedSpec, allowedOperationIds);

  const { observer, analytics } = createObserver(verifier, analyticsFlushIntervalMs, analyticsTimeoutMs);
  shutdownHooks.push(async () => {
    await observer.settle();
    await analytics.flush();
  });

  const mcpServer = new MCPServer(observer);
  if (docsCorpusPath) mcpServer.registerTool(new DocsSearchTool(DocsIndex.fromCorpusFile(docsCorpusPath)));
  mcpServer.registerTool(new ApiSearchTool(catalog));
  mcpServer.registerTool(new ApiDetailsTool(catalog));
  mcpServer.registerTool(new SampleRequestTool(catalog));
  mcpServer.registerTool(new ImplementationPlannerTool());
  mcpServer.registerTool(new ApiReadTool(dispatcher, readOperationIds));
  mcpServer.registerTool(new ApiWriteTool(dispatcher, writeOperationIds));

  return createHttpServer(mcpServer);
}
