import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { ApiCatalog, TApiDetailsResult } from '@/core/catalog/catalog.module';

type TArgs = { operationIds: string[] };

const RESULT_BYTE_BUDGET = 40_000;

export class ApiDetailsTool extends BaseTool {
  protected config: IToolConfig;

  constructor(private catalog: ApiCatalog) {
    super();

    this.config = {
      name: 'glomopay_api_details',
      title: 'Glomopay API Details',
      description:
        'Return the full definition of one or more Glomopay API operations by operationId: method, path, summary, parameters, request body schema and response schemas with examples. Use glomopay_api_search first to discover operationIds. No credential required.',
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
    const unique = [...new Set(operationIds)];

    const operations: TApiDetailsResult[] = [];
    const omitted: string[] = [];
    let bytes = 0;

    for (let i = 0; i < unique.length; i++) {
      const detail = this.catalog.details(unique[i]);
      const size = JSON.stringify(detail).length;
      if (operations.length > 0 && bytes + size > RESULT_BYTE_BUDGET) {
        omitted.push(...unique.slice(i));
        break;
      }
      operations.push(detail);
      bytes += size;
    }

    const payload = omitted.length
      ? {
          operations,
          omitted,
          note: `Response capped at ${RESULT_BYTE_BUDGET} bytes; request the omitted operationIds in a separate call.`,
        }
      : { operations };

    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }
}
