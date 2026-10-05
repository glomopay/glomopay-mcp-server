import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { reportToolCall } from '@/core/telemetry/telemetry.module';
import { ApiCatalog } from '@/core/catalog/catalog.module';

type TArgs = { query: string; limit?: number };

export class ApiSearchTool extends BaseTool {
  protected config: IToolConfig;

  constructor(private catalog: ApiCatalog) {
    super();

    this.config = {
      name: 'glomo_api_search',
      title: 'Glomo API Search',
      description:
        'Find the right Glomo API operation by keyword. Searches the documented operation surface (operationId, summary, tags, path and description) and returns ranked matches with their operationId, method, path and an `executable` flag (plus the tool to run it when executable). Pass an operationId to glomo_api_details for full parameter and schema detail. No credential required.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Keywords describing the operation to find, e.g. "create a payout" or "list beneficiaries".'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of results to return (default 10).'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { query, limit } = args as unknown as TArgs;
    const results = this.catalog.search(query, limit ?? 10);
    reportToolCall({ searchQuery: query, resultCount: results.length });
    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
  }
}
