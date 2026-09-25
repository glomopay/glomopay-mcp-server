import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { ApiCatalog } from '@/core/catalog/catalog.module';

type TArgs = { operationIds: string[] };

export class ApiDetailsTool extends BaseTool {
  protected config: IToolConfig;

  constructor(private catalog: ApiCatalog) {
    super();

    this.config = {
      name: 'glomopay_api_details',
      title: 'Glomopay API Details',
      description:
        'Return the full definition of one or more Glomopay API operations by operationId: method, path, summary, parameters, request body schema and response schemas. Use glomopay_api_search first to discover operationIds. No credential required.',
      inputSchema: {
        operationIds: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(10)
          .describe('The operationIds to describe, e.g. ["createPayout", "getPayouts"].'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { operationIds } = args as unknown as TArgs;
    const operations = operationIds.map((operationId) => this.catalog.details(operationId));
    return { content: [{ type: 'text', text: JSON.stringify({ operations }) }] };
  }
}
