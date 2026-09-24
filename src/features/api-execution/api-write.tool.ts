import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig, TToolExtra } from '@/shared/tool/tool.module';
import { Dispatcher } from '@/core/dispatcher/dispatcher.module';

type TArgs = { operationId: string; params?: Record<string, unknown> };

export class ApiWriteTool extends BaseTool {
  protected config: IToolConfig;

  constructor(
    private dispatcher: Dispatcher,
    operationIds: string[],
  ) {
    super();

    const operationId = (operationIds.length ? z.enum(operationIds as [string, ...string[]]) : z.string()).describe(
      'The operationId of the POST/PATCH/DELETE operation to run, e.g. "createCustomer".',
    );

    this.config = {
      name: 'glomopay_api_write',
      title: 'Glomopay API Write',
      description:
        "Execute a write (POST/PATCH/DELETE) Glomopay API operation by operationId against the caller's account. Only allowlisted write operations are permitted.",
      inputSchema: {
        operationId,
        params: z.record(z.string(), z.unknown()).optional().describe('Path, query and body parameters, flattened into a single object.'),
      },
    };
  }

  execute(args: ZodRawShape, extra: TToolExtra): Promise<CallToolResult> {
    const { operationId, params } = args as unknown as TArgs;
    return this.dispatcher.dispatch(operationId, params, extra, ['POST', 'PATCH', 'DELETE']);
  }
}
