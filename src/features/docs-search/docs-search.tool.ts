import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { reportToolCall } from '@/core/telemetry/telemetry.module';
import { DocsIndex } from '@/core/docs/docs.module';

type TArgs = { query: string; limit?: number };

export class DocsSearchTool extends BaseTool {
  protected config: IToolConfig;

  constructor(private index: DocsIndex) {
    super();

    this.config = {
      name: 'glomo_docs_search',
      title: 'glomo Docs Search',
      description:
        'Search the glomo developer documentation (guides, concepts and integration flows) and return cited excerpts with their source URLs. No credential required.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('The integration question or keywords to search the documentation for.'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum number of results to return (default 5).'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { query, limit } = args as unknown as TArgs;
    const results = this.index.search(query, limit ?? 5);
    reportToolCall({ searchQuery: query, resultCount: results.length });
    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
  }
}
