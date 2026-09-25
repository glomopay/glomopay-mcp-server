import type { Express } from 'express';

import { MCPServer } from '@/core/mcp-server/mcp-server.module';
import { createHttpServer } from '@/core/http/http-server.module';
import { Dispatcher, loadSpecDocument, buildSpecIndex } from '@/core/dispatcher/dispatcher.module';
import { buildCatalog } from '@/core/catalog/catalog.module';
import { executionAllowlist } from '@/features/allowlist/allowlist.module';
import { ApiReadTool, ApiWriteTool } from '@/features/api-execution/api-execution.module';
import { ApiSearchTool, ApiDetailsTool } from '@/features/api-discovery/api-discovery.module';
import { SampleRequestTool } from '@/features/sample-request/sample-request.module';
import { ImplementationPlannerTool } from '@/features/implementation-planner/implementation-planner.module';
import { DocsIndex } from '@/core/docs/docs.module';
import { DocsSearchTool } from '@/features/docs-search/docs-search.module';
import { ApiClient } from '@/shared/api-client/api-client.module';

export interface ICreateAppOptions {
  specPath: string;
  apiHost?: string;
  docsCorpusPath?: string;
}

export async function createApp({ specPath, apiHost, docsCorpusPath }: ICreateAppOptions): Promise<Express> {
  const apiClient = new ApiClient({ baseURL: apiHost });
  const parsedSpec = await loadSpecDocument(specPath);
  const specIndex = buildSpecIndex(parsedSpec);

  const allowedOperationIds = [...executionAllowlist].filter((operationId) => {
    if (specIndex.has(operationId)) return true;
    console.error(`[allowlist] operationId "${operationId}" is not present in the fetched spec`);
    return false;
  });
  const readOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method === 'GET');
  const writeOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method !== 'GET');

  const dispatcher = new Dispatcher(specIndex, executionAllowlist, apiClient);
  const catalog = buildCatalog(parsedSpec, allowedOperationIds);

  const mcpServer = new MCPServer();
  if (docsCorpusPath) mcpServer.registerTool(new DocsSearchTool(DocsIndex.fromCorpusFile(docsCorpusPath)));
  mcpServer.registerTool(new ApiSearchTool(catalog));
  mcpServer.registerTool(new ApiDetailsTool(catalog));
  mcpServer.registerTool(new SampleRequestTool(catalog));
  mcpServer.registerTool(new ImplementationPlannerTool());
  mcpServer.registerTool(new ApiReadTool(dispatcher, readOperationIds));
  mcpServer.registerTool(new ApiWriteTool(dispatcher, writeOperationIds));

  return createHttpServer(mcpServer);
}
