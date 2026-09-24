import type { Express } from 'express';

import { MCPServer } from '@/core/mcp-server/mcp-server.module';
import { createHttpServer } from '@/core/http/http-server.module';
import { Dispatcher, loadSpecIndex } from '@/core/dispatcher/dispatcher.module';
import { executionAllowlist } from '@/features/allowlist/allowlist.module';
import { ApiReadTool, ApiWriteTool } from '@/features/api-execution/api-execution.module';
import { HealthCheckTool } from '@/features/health-check/health-check.module';
import { ApiClient } from '@/shared/api-client/api-client.module';

export interface ICreateAppOptions {
  specPath: string;
  apiHost?: string;
}

export async function createApp({ specPath, apiHost }: ICreateAppOptions): Promise<Express> {
  const apiClient = new ApiClient({ baseURL: apiHost });
  const specIndex = await loadSpecIndex(specPath);

  const allowedOperationIds = [...executionAllowlist].filter((operationId) => {
    if (specIndex.has(operationId)) return true;
    console.error(`[allowlist] operationId "${operationId}" is not present in the fetched spec`);
    return false;
  });
  const readOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method === 'GET');
  const writeOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method !== 'GET');

  const dispatcher = new Dispatcher(specIndex, executionAllowlist, apiClient);

  const mcpServer = new MCPServer();
  mcpServer.registerTool(new ApiReadTool(dispatcher, readOperationIds));
  mcpServer.registerTool(new ApiWriteTool(dispatcher, writeOperationIds));
  mcpServer.registerTool(new HealthCheckTool());

  return createHttpServer(mcpServer);
}
