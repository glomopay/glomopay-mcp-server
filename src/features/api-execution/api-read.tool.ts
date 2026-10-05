import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig, TToolExtra } from '@/shared/tool/tool.module';
import { Dispatcher } from '@/core/dispatcher/dispatcher.module';

type TArgs = { operationId: string; params?: Record<string, unknown> };

export class ApiReadTool extends BaseTool {
  protected config: IToolConfig;

  constructor(
    private dispatcher: Dispatcher,
    operationIds: string[],
  ) {
    super();

    const operationId = (operationIds.length ? z.enum(operationIds as [string, ...string[]]) : z.string()).describe(
      'The operationId of the GET operation to run, e.g. "getCustomers".',
    );

    this.config = {
      name: 'glomo_api_read',
      title: 'Glomo API Read',
      description:
        "Execute a read-only (GET) Glomo API operation by operationId against the caller's account. Only allowlisted GET operations are permitted.",
      inputSchema: {
        operationId,
        params: z.record(z.string(), z.unknown()).optional().describe('Path and query parameters, flattened into a single object.'),
      },
    };
  }

  execute(args: ZodRawShape, extra: TToolExtra): Promise<CallToolResult> {
    const { operationId, params } = args as unknown as TArgs;
    return this.dispatcher.dispatch(operationId, params, extra, ['GET']);
  }
}
