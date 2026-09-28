import { CallToolResult, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ZodRawShape } from 'zod';

import type { TToolName } from './tool-names';

export type TToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface IToolConfig {
  name: TToolName;
  title?: string;
  description?: string;
  inputSchema?: ZodRawShape;
}

export interface IToolHandler {
  (args: ZodRawShape, extra: TToolExtra): Promise<CallToolResult> | CallToolResult;
}
