import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { reportToolCall } from '@/core/telemetry/telemetry.module';
import { ApiCatalog } from '@/core/catalog/catalog.module';
import { buildSampleRequest, renderSample, type TSampleLanguage } from '@/core/sample/sample.module';

type TArgs = { operationId: string; language?: TSampleLanguage };

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export class SampleRequestTool extends BaseTool {
  protected config: IToolConfig;

  constructor(private catalog: ApiCatalog) {
    super();

    this.config = {
      name: 'glomo_sample_request',
      title: 'Glomo Sample Request',
      description:
        'Generate a ready-to-run sample request (cURL, Python or Node) for a Glomo API operation, built from the real OpenAPI schema and its examples. The credential is read from a GLOMO_API_KEY environment variable placeholder; no credential is used or required to call this tool. Sandbox and live share the same base URL — the API key selects the environment, so there is no separate sandbox host.',
      inputSchema: {
        operationId: z
          .string()
          .min(1)
          .max(100)
          .describe('The operationId to generate a sample for, e.g. "createPayout". Use glomo_api_search to find it.'),
        language: z.enum(['curl', 'python', 'node']).optional().describe('Output format (default "curl").'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { operationId, language } = args as unknown as TArgs;
    const entry = this.catalog.details(operationId);
    if ('error' in entry) {
      reportToolCall({ errorCode: 'unknown_operation' });
      return errorResult(entry.error);
    }
    reportToolCall({ operationId });

    const request = buildSampleRequest(entry, this.catalog.origin);
    const snippet = renderSample(request, language ?? 'curl');
    return { content: [{ type: 'text', text: snippet }] };
  }
}
