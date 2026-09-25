import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';

type TArgs = { goal: string };

const SKILLS_URL = 'https://docs.glomo.one/.well-known/skills/index.json';

export class ImplementationPlannerTool extends BaseTool {
  protected config: IToolConfig;

  constructor() {
    super();

    this.config = {
      name: 'glomo_implementation_planner',
      title: 'glomo Implementation Planner',
      description:
        'Sequence a full glomo integration for a stated goal. Not available yet: authored per-flow call sequences are still being written (KAN-8608). Until they land, use glomo_docs_search and the published glomo skills to assemble the call order. No credential required.',
      inputSchema: {
        goal: z.string().min(1).max(500).describe('The integration goal in plain language, e.g. "accept card payments from US customers".'),
      },
    };
  }

  execute(args: ZodRawShape): CallToolResult {
    const { goal } = args as unknown as TArgs;
    const payload = {
      status: 'not_available',
      goal,
      message:
        'The implementation planner is not available yet — authored per-flow call sequences are still being written. Ordering an integration from the raw spec is not safe, so no plan is generated. For now, search the documentation and follow the published skills.',
      use: {
        tools: ['glomo_docs_search', 'glomo_api_search', 'glomo_api_details'],
        skills: SKILLS_URL,
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }
}
