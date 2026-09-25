import { McpServer as McpServerInternal } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { BaseTool } from '@/shared/tool/tool.module';
import type { ToolCallObserver } from '@/core/telemetry/telemetry.module';

export class MCPServer {
  private static SERVER_NAME = 'glomopay';
  private static SERVER_VERSION = '1.0.0';

  private tools: BaseTool[] = [];

  constructor(private observer?: ToolCallObserver) {}

  registerTool(tool: BaseTool) {
    this.tools.push(tool);

    return this;
  }

  async connect(transport: Transport) {
    const server = new McpServerInternal({
      name: MCPServer.SERVER_NAME,
      version: MCPServer.SERVER_VERSION,
    });

    for (const tool of this.tools) {
      const config = tool.getConfig();
      server.registerTool(
        tool.getName(),
        {
          title: config.title,
          description: config.description,
          inputSchema: config.inputSchema,
        },
        tool.handler,
      );
    }

    await server.connect(transport);
    this.observer?.attach(transport, new Set(this.tools.map((tool) => tool.getName())));
  }
}
