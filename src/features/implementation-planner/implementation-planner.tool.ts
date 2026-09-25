import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { ApiCatalog } from '@/core/catalog/catalog.module';
import { DocsIndex } from '@/core/docs/docs.module';
import { planIntegration } from '@/core/planner/planner.module';

type TArgs = { goal: string; limit?: number };

export class ImplementationPlannerTool extends BaseTool {
  protected config: IToolConfig;

  constructor(
    private catalog: ApiCatalog,
    private docsIndex?: DocsIndex,
  ) {
    super();

    this.config = {
      name: 'glomo_implementation_planner',
      title: 'glomo Implementation Planner',
      description:
        'Sequence a full glomo integration for a stated goal (e.g. "accept card payments from US customers"). Returns an ordered call plan of operations — sequenced by their data dependencies — with each step\'s executable tool, plus cited documentation links. No credential required.',
      inputSchema: {
        goal: z.string().min(1).max(500).describe('The integration goal in plain language, e.g. "accept card payments from US customers".'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum number of operations to include in the plan (default 8).'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { goal, limit } = args as unknown as TArgs;
    const plan = planIntegration({ catalog: this.catalog, docsIndex: this.docsIndex, goal, limit });
    return { content: [{ type: 'text', text: JSON.stringify(plan) }] };
  }
}
