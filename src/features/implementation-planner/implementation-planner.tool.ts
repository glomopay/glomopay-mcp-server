import { z, ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { BaseTool, IToolConfig } from '@/shared/tool/tool.module';
import { reportToolCall } from '@/core/telemetry/telemetry.module';
import type { ApiCatalog } from '@/core/catalog/catalog.module';
import { FlowIndex, type IFlow, type IFlowGuide, type TFlowStep } from '@/core/planner/planner.module';

type TArgs = { flow?: string; goal?: string };

const SKILLS_URL = 'https://docs.glomo.one/.well-known/skills/index.json';
const CANDIDATE_LIMIT = 3;

function json(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function refuse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export class ImplementationPlannerTool extends BaseTool {
  protected config: IToolConfig;
  private index?: FlowIndex;

  constructor(
    private catalog: ApiCatalog,
    private guide?: IFlowGuide,
  ) {
    super();

    if (!guide) {
      this.config = {
        name: 'glomo_implementation_planner',
        title: 'Glomo Implementation Planner',
        description:
          'Not available yet: the Glomo integration planner has no authored flows to read on this server and does not return a plan. Use glomo_docs_search and the published Glomo skills to assemble the call order. No credential required.',
        inputSchema: {
          goal: z.string().min(1).max(500).describe('The integration goal in plain language, e.g. "accept card payments from US customers".'),
        },
      };
      return;
    }

    this.index = new FlowIndex(guide);
    const ids = guide.flows.map((flow) => flow.id) as [string, ...string[]];
    this.config = {
      name: 'glomo_implementation_planner',
      title: 'Glomo Implementation Planner',
      description:
        "Return Glomo's authored, ordered API call sequence for an integration flow, copied verbatim from the Get started page of the docs. " +
        `Pass \`flow\` to get the plan: ${guide.flows.map((flow) => `${flow.id} (${flow.title})`).join(', ')}. ` +
        'Pass `goal` instead to get the flows that best match it, then call again with the chosen `flow`. ' +
        'Each API step names its operationId; read it with glomo_api_details before calling. Steps are never invented: a goal with no authored flow says so. No credential required.',
      inputSchema: {
        flow: z.enum(ids).optional().describe('The flow to plan, by id.'),
        goal: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('The integration goal in plain language, used to find matching flows when `flow` is not given.'),
      },
    };
  }

  private step(step: TFlowStep) {
    if (step.kind === 'not_api') return step;
    const entry = this.catalog.details(step.operationId);
    const executable = 'executable' in entry && entry.executable;
    return { ...step, executable, ...(executable && entry.tool ? { tool: entry.tool } : {}) };
  }

  private plan(flow: IFlow, guide: IFlowGuide): CallToolResult {
    return json({
      status: 'ok',
      source: guide.source,
      flow: { id: flow.id, title: flow.title, summary: flow.summary, url: flow.url },
      variants: flow.variants.map((variant) => ({ name: variant.name, steps: variant.steps.map((step) => this.step(step)), guide: variant.guide })),
      sharedNotes: guide.sharedNotes,
    });
  }

  execute(args: ZodRawShape): CallToolResult {
    const { flow: flowId, goal } = args as unknown as TArgs;
    if (goal) reportToolCall({ searchQuery: goal });
    const { guide, index } = this;

    if (!guide || !index) {
      return json({
        status: 'not_available',
        goal,
        message:
          'The implementation planner has no authored flows to read on this server, so no plan is generated. Ordering an integration from the raw spec is not safe. Search the documentation and follow the published skills instead.',
        use: { tools: ['glomo_docs_search', 'glomo_api_search', 'glomo_api_details'], skills: SKILLS_URL },
      });
    }

    if (flowId) {
      const flow = guide.flows.find((entry) => entry.id === flowId);
      if (!flow) return refuse(`Unknown flow "${flowId}".`);
      return this.plan(flow, guide);
    }

    if (!goal) return refuse('Pass either `flow` (a flow id) or `goal` (a plain-language goal).');

    const candidates = index.candidates(goal, CANDIDATE_LIMIT);
    const flows = guide.flows.map((flow) => ({ id: flow.id, title: flow.title }));
    if (candidates.length === 0) {
      return json({
        status: 'no_authored_flow',
        goal,
        message: 'No authored flow matches this goal. Pick one of the flows below if it fits, or search the documentation with glomo_docs_search.',
        flows,
      });
    }
    return json({
      status: 'select_flow',
      goal,
      message:
        'These authored flows match the goal best. Call again with `flow` set to the one that fits to get its ordered calls. If none fits, there is no authored flow for this goal.',
      candidates,
      flows,
    });
  }
}
