import path from 'path';

import { MCPServer } from '@/core/mcp-server/mcp-server.module';
import { createHttpServer } from '@/core/http/http-server.module';
import { Dispatcher, loadSpecIndex } from '@/core/dispatcher/dispatcher.module';
import { executionAllowlist } from '@/features/allowlist/allowlist.module';
import { ApiReadTool, ApiWriteTool } from '@/features/api-execution/api-execution.module';
import { ApiClient } from '@/shared/api-client/api-client.module';
import { config } from '@/features/app-config/app-config.module';
import { HealthCheckTool } from './features/health-check/health-check.module';

(async () => {
  const mcpServer = MCPServer.getInstance();

  const apiClient = new ApiClient({
    baseURL: config.glomopay.apiHost,
  });

  // Spec is fetched at build time (scripts/fetch-spec.mjs) into dist/, never at runtime.
  const specFilePath = path.resolve(__dirname, 'openapi.json');
  const specIndex = await loadSpecIndex(specFilePath);

  const allowedOperationIds = [...executionAllowlist].filter((operationId) => {
    if (specIndex.has(operationId)) return true;
    console.error(`[allowlist] operationId "${operationId}" is not present in the fetched spec`);
    return false;
  });
  const readOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method === 'GET');
  const writeOperationIds = allowedOperationIds.filter((operationId) => specIndex.get(operationId)!.method !== 'GET');

  const dispatcher = new Dispatcher(specIndex, executionAllowlist, apiClient);

  mcpServer.registerTool(new ApiReadTool(dispatcher, readOperationIds));
  mcpServer.registerTool(new ApiWriteTool(dispatcher, writeOperationIds));
  mcpServer.registerTool(new HealthCheckTool());

  const app = createHttpServer(mcpServer);
  app.listen(config.http.port, config.http.host, () => {
    console.error(`Glomopay MCP Server running on HTTP ${config.http.host}:${config.http.port}/mcp`);
  });
})();
