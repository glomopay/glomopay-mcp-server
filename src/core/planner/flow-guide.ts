import { buildCorpus, DOCS_ORIGIN, type ICorpusPage } from '@/core/docs/docs.module';

export const FLOW_GUIDE_URL = `${DOCS_ORIGIN}/get-started`;

const FLOWS_HEADING = 'What are you building?';
const API_STEP = /^`([A-Za-z][A-Za-z0-9]*)` `(GET|POST|PUT|PATCH|DELETE) (\/\S*)` — (.+)$/;
const NOT_API_STEP = /^\*\*Not an API call:\*\* (.+)$/;
const NUMBERED = /^(\d+)\. (.*)$/;
const FULL_GUIDE = /^Full guide: \[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/;
const SHARED_CALLS = /^Shared calls: /;

export type TFlowStep =
  | { step: number; kind: 'api'; operationId: string; method: string; path: string; note: string }
  | { step: number; kind: 'not_api'; note: string };

export interface IFlowVariant {
  name: string;
  steps: TFlowStep[];
  guide: { title: string; url: string };
}

export interface IFlow {
  id: string;
  title: string;
  summary: string;
  url: string;
  variants: IFlowVariant[];
}

export interface IFlowGuide {
  source: string;
  sharedNotes: string;
  flows: IFlow[];
}

export class FlowFormatError extends Error {}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseStep(number: number, text: string, where: string): TFlowStep {
  const api = text.match(API_STEP);
  if (api) return { step: number, kind: 'api', operationId: api[1], method: api[2], path: api[3], note: api[4] };
  const external = text.match(NOT_API_STEP);
  if (external) return { step: number, kind: 'not_api', note: external[1] };
  throw new FlowFormatError(`${where}: step ${number} matches neither step format: ${text}`);
}

interface ISection {
  title: string;
  intro: string[];
  variants: IFlowVariant[];
}

export function parseFlowGuide(content: string, source: string = FLOW_GUIDE_URL): IFlowGuide {
  const flows: IFlow[] = [];
  let sharedNotes = '';
  let inFlows = false;
  let section: ISection | null = null;
  let variant: (Omit<IFlowVariant, 'guide'> & { guide?: IFlowVariant['guide'] }) | null = null;

  const closeVariant = () => {
    if (!variant || !section) return;
    const where = `"${section.title} / ${variant.name}"`;
    if (variant.steps.length === 0) throw new FlowFormatError(`${where} has no steps`);
    if (!variant.guide) throw new FlowFormatError(`${where} does not end with a Full guide link`);
    section.variants.push({ name: variant.name, steps: variant.steps, guide: variant.guide });
    variant = null;
  };

  const closeSection = () => {
    closeVariant();
    if (section && section.variants.length === 0) {
      const stepLike = section.intro.find((line) => {
        const body = line.replace(NUMBERED, '$2');
        return FULL_GUIDE.test(line) || API_STEP.test(body) || NOT_API_STEP.test(body);
      });
      if (stepLike) throw new FlowFormatError(`"${section.title}" has steps but no ### variant: ${stepLike}`);
    }
    if (section && section.variants.length > 0) {
      const id = slugify(section.title);
      if (flows.some((flow) => flow.id === id)) throw new FlowFormatError(`"${section.title}" has the same id as an earlier flow: ${id}`);
      flows.push({
        id,
        title: section.title,
        summary: section.intro.join(' ').trim(),
        url: `${source}#${id}`,
        variants: section.variants,
      });
    }
    section = null;
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2 && !line.startsWith('###')) {
      closeSection();
      if (h2[1].trim() === FLOWS_HEADING) {
        inFlows = true;
        continue;
      }
      if (inFlows) section = { title: h2[1].trim(), intro: [], variants: [] };
      continue;
    }
    if (!inFlows) continue;

    if (!section) {
      if (SHARED_CALLS.test(line)) sharedNotes = line;
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      closeVariant();
      variant = { name: h3[1].trim(), steps: [] };
      continue;
    }

    if (!variant) {
      if (line && !line.startsWith('<!--')) section.intro.push(line);
      continue;
    }

    if (!line) continue;
    const where = `"${section.title} / ${variant.name}"`;
    if (variant.guide) throw new FlowFormatError(`${where} has content after its Full guide link: ${line}`);

    const guide = line.match(FULL_GUIDE);
    if (guide) {
      variant.guide = { title: guide[1], url: guide[2] };
      continue;
    }

    const numbered = line.match(NUMBERED);
    if (!numbered) throw new FlowFormatError(`${where} has a line that is not a step: ${line}`);
    const number = Number(numbered[1]);
    if (number !== variant.steps.length + 1) {
      throw new FlowFormatError(`${where}: expected step ${variant.steps.length + 1}, found ${number}`);
    }
    variant.steps.push(parseStep(number, numbered[2], where));
  }
  closeSection();

  if (!inFlows) throw new FlowFormatError(`no "## ${FLOWS_HEADING}" section in ${source}`);
  if (flows.length === 0) throw new FlowFormatError(`no flows found in ${source}`);
  if (!sharedNotes) throw new FlowFormatError(`no "Shared calls:" line under "## ${FLOWS_HEADING}" in ${source}`);
  return { source, sharedNotes, flows };
}

export function flowGuideFromCorpus(pages: Pick<ICorpusPage, 'url' | 'content'>[], source: string = FLOW_GUIDE_URL): IFlowGuide {
  const page = pages.find((entry) => entry.url === source);
  if (!page) throw new FlowFormatError(`${source} is not in the docs corpus`);
  return parseFlowGuide(page.content, source);
}

export interface ISpecOperation {
  method: string;
  path: string;
}

export function findFlowProblems(guide: IFlowGuide, operations: ReadonlyMap<string, ISpecOperation>): string[] {
  const problems: string[] = [];
  for (const flow of guide.flows) {
    for (const variant of flow.variants) {
      for (const step of variant.steps) {
        if (step.kind !== 'api') continue;
        const where = `"${flow.title} / ${variant.name}" step ${step.step}`;
        const operation = operations.get(step.operationId);
        if (!operation) {
          problems.push(`${where}: ${step.operationId} is not in the published spec`);
        } else if (operation.method !== step.method || operation.path !== step.path) {
          problems.push(`${where}: ${step.operationId} is ${operation.method} ${operation.path} in the spec, not ${step.method} ${step.path}`);
        }
      }
    }
  }
  return problems;
}

const SPEC_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function specOperations(document: { paths?: Record<string, Record<string, unknown> | undefined> }): Map<string, ISpecOperation> {
  const operations = new Map<string, ISpecOperation>();
  for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      const operationId = (operation as { operationId?: unknown } | undefined)?.operationId;
      if (SPEC_METHODS.has(method) && typeof operationId === 'string') operations.set(operationId, { method: method.toUpperCase(), path: rawPath });
    }
  }
  return operations;
}

export async function buildCheckedCorpus(operations: ReadonlyMap<string, ISpecOperation>): Promise<{ corpus: ICorpusPage[]; guide: IFlowGuide }> {
  const corpus = await buildCorpus();
  const guide = flowGuideFromCorpus(corpus);
  const problems = findFlowProblems(guide, operations);
  if (problems.length > 0) throw new FlowFormatError(`authored flows do not match the spec:\n  ${problems.join('\n  ')}`);
  return { corpus, guide };
}
