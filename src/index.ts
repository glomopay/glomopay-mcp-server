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

  // Origin only; the versioned base path is resolved per operation (see spec-index).
  const apiClient = new ApiClient({
    baseURL: config.glomopay.apiHost,
  });

  // Spec is fetched at build time (scripts/fetch-spec.mjs) into dist/, never at runtime.
  const specFilePath = path.resolve(__dirname, 'openapi.json');
  const specIndex = await loadSpecIndex(specFilePath);

  for (const operationId of executionAllowlist) {
    if (!specIndex.has(operationId)) {
      console.error(`[allowlist] operationId "${operationId}" is not present in the fetched spec`);
    }
  }

  const dispatcher = new Dispatcher(specIndex, executionAllowlist, apiClient);

  mcpServer.registerTool(new ApiReadTool(dispatcher));
  mcpServer.registerTool(new ApiWriteTool(dispatcher));
  mcpServer.registerTool(new HealthCheckTool());

  const app = createHttpServer(mcpServer);
  app.listen(config.http.port, config.http.host, () => {
    console.error(`Glomopay MCP Server running on HTTP ${config.http.host}:${config.http.port}/mcp`);
  });
})();
