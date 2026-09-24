import { CallToolResult, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ZodRawShape } from 'zod';

export type TToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface IToolConfig {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: ZodRawShape;
}

export interface IToolHandler {
  (args: ZodRawShape, extra: TToolExtra): Promise<CallToolResult> | CallToolResult;
}
