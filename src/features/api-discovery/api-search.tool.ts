import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { ApiCatalog } from '@/core/catalog/catalog.module';

type TArgs = { query: string; limit?: number };

export class ApiSearchTool extends BaseTool {
  protected config: IToolConfig;

  constructor(private catalog: ApiCatalog) {
    super();

    this.config = {
      name: 'glomo_api_search',
      title: 'glomo API Search',
      description:
        'Find the right glomo API operation by keyword. Searches the callable operation surface (operationId, summary, tags, path and description) and returns ranked matches with their operationId, method and path. Pass an operationId to glomo_api_details for full parameter and schema detail. No credential required.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Keywords describing the operation to find, e.g. "create a payout" or "list beneficiaries".'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of results to return (default 10).'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { query, limit } = args as unknown as TArgs;
    const results = this.catalog.search(query, limit ?? 10);
    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
  }
}
