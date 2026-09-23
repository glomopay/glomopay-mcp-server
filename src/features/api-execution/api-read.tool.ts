import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig, TToolExtra } from '@/shared/tool/tool.module';
import { Dispatcher } from '@/core/dispatcher/dispatcher.module';

const inputSchema = {
  operationId: z.string().describe('The OpenAPI operationId of the GET operation to run, e.g. "getCustomers".'),
  params: z.record(z.string(), z.unknown()).optional().describe('Path and query parameters for the operation, flattened into a single object.'),
};

type TArgs = { operationId: string; params?: Record<string, unknown> };

export class ApiReadTool extends BaseTool {
  protected config: IToolConfig = {
    name: 'glomopay_api_read',
    title: 'Glomopay API Read',
    description:
      "Execute a read-only (GET) Glomopay API operation by operationId against the caller's account. " +
      'Only operations on the execution allowlist are permitted. Use the API discovery tools to find operationIds and their parameters.',
    inputSchema,
  };

  constructor(private dispatcher: Dispatcher) {
    super();
  }

  execute(args: ZodRawShape, extra: TToolExtra): Promise<CallToolResult> {
    const { operationId, params } = args as unknown as TArgs;
    return this.dispatcher.dispatch(operationId, params, extra, ['GET']);
  }
}
