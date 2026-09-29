import path from 'node:path';
import os from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, type ICorpusPage } from '@/core/docs/docs.module';
import {
  buildCheckedCorpus,
  findFlowProblems,
  flowGuideFromCorpus,
  FLOW_GUIDE_URL,
  specOperations,
  type ISpecOperation,
} from '@/core/planner/planner.module';
import { callTool, isRefused, resultText, startTestServer, withCassette, type ITestServer, type IToolResponse } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');
const FLOW_IDS = ['one-time-collection', 'subscriptions', 'lrs-remittance', 'payouts', 'bank-transfer-collection', 'bank-account-verification-tpv'];

type TStep =
  | { step: number; kind: 'api'; operationId: string; method: string; path: string; note: string; executable: boolean; tool?: string }
  | { step: number; kind: 'not_api'; note: string };

interface IPlan {
  status: string;
  source: string;
  flow: { id: string; title: string; summary: string; url: string };
  variants: { name: string; steps: TStep[]; guide: { title: string; url: string } }[];
  sharedNotes: string;
}

let corpus: ICorpusPage[] = [];
let guidePage: ICorpusPage;
const servers: ITestServer[] = [];
const tempFiles: string[] = [];
let server: ITestServer;

function writeCorpus(pages: ICorpusPage[], name: string): string {
  const file = path.join(os.tmpdir(), `planner-${name}-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(pages));
  tempFiles.push(file);
  return file;
}

async function start(docsCorpusPath?: string): Promise<ITestServer> {
  const started = await startTestServer({ specPath: DISCOVERY_SPEC, docsCorpusPath });
  servers.push(started);
  return started;
}

function withGuideContent(content: string): ICorpusPage[] {
  return corpus.map((page) => (page.url === FLOW_GUIDE_URL ? { ...page, content } : page));
}

beforeAll(async () => {
  await withCassette('docs-corpus.json', async () => {
    corpus = await buildCorpus();
  });
  guidePage = corpus.find((page) => page.url === FLOW_GUIDE_URL)!;
  server = await start(writeCorpus(corpus, 'recorded'));
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await Promise.all(servers.map((entry) => entry.close()));
  for (const file of tempFiles) rmSync(file, { force: true });
});

function plan(url: string, args: Record<string, unknown>): Promise<IToolResponse> {
  return callTool(url, 'glomo_implementation_planner', args);
}

async function payload<T>(url: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(resultText(await plan(url, args))) as T;
}

function render(step: TStep): string {
  return step.kind === 'api'
    ? `${step.step}. \`${step.operationId}\` \`${step.method} ${step.path}\` — ${step.note}`
    : `${step.step}. **Not an API call:** ${step.note}`;
}

async function plannerSchema(url: string): Promise<{ properties: Record<string, { enum?: string[] }> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await response.text();
  const line = text.split('\n').find((entry) => entry.startsWith('data:'));
  const parsed = JSON.parse((line ?? text).replace(/^data:\s*/, '')) as { result: { tools: { name: string; inputSchema: never }[] } };
  return parsed.result.tools.find((tool) => tool.name === 'glomo_implementation_planner')!.inputSchema;
}

describe('glomo_implementation_planner: plans for a flow', () => {
  it('offers exactly the authored flows as the flow parameter', async () => {
    expect((await plannerSchema(server.url)).properties.flow.enum).toEqual(FLOW_IDS);
  });

  it('returns the payouts calls in the authored order with the guide link', async () => {
    const result = await payload<IPlan>(server.url, { flow: 'payouts' });
    expect(result.status).toBe('ok');
    expect(result.flow).toMatchObject({ id: 'payouts', title: 'Payouts', url: `${FLOW_GUIDE_URL}#payouts` });
    expect(result.variants).toHaveLength(1);
    const [variant] = result.variants;
    expect(variant.steps.map((step) => (step.kind === 'api' ? step.operationId : 'not_api'))).toEqual([
      'createBeneficiaryV2',
      'getBeneficiaryByIdV2',
      'createDocument',
      'createQuote',
      'createPayout',
      'getPayoutById',
    ]);
    expect(variant.guide.url).toBe('https://docs.glomo.one/payout/set-up');
  });

  it('returns every variant of a flow, including steps that are not API calls', async () => {
    const result = await payload<IPlan>(server.url, { flow: 'one-time-collection' });
    expect(result.variants.map((variant) => variant.name)).toEqual(['SDK checkout', 'Payment API (server-to-server)', 'Payment link (no frontend)']);
    expect(result.variants[0].steps[2]).toMatchObject({ step: 3, kind: 'not_api' });
  });

  it('copies every step of every flow verbatim from the docs page and invents none', async () => {
    for (const id of FLOW_IDS) {
      const result = await payload<IPlan>(server.url, { flow: id });
      for (const variant of result.variants) {
        for (const step of variant.steps) expect(guidePage.content).toContain(render(step));
      }
    }
  });

  it('marks which API steps this server can execute, and with which tool', async () => {
    const steps = (await payload<IPlan>(server.url, { flow: 'payouts' })).variants[0].steps;
    const byId = new Map(steps.flatMap((step) => (step.kind === 'api' ? [[step.operationId, step] as const] : [])));
    expect(byId.get('createPayout')).toMatchObject({ executable: true, tool: 'glomo_api_write' });
    expect(byId.get('getBeneficiaryByIdV2')).toMatchObject({ executable: true, tool: 'glomo_api_read' });
    expect(byId.get('createDocument')).toMatchObject({ executable: false });
    expect(byId.get('createDocument')).not.toHaveProperty('tool');
  });

  it('marks the LRS remittance API steps executable, but not the multipart document upload', async () => {
    const [remittance, withdrawal] = (await payload<IPlan>(server.url, { flow: 'lrs-remittance' })).variants;
    const byId = new Map(
      [...remittance.steps, ...withdrawal.steps].flatMap((step) => (step.kind === 'api' ? [[step.operationId, step] as const] : [])),
    );
    expect(byId.get('getLrsBanks')).toMatchObject({ executable: true, tool: 'glomo_api_read' });
    expect(byId.get('createLrsCustomerBankAccount')).toMatchObject({ executable: true, tool: 'glomo_api_write' });
    expect(byId.get('createLrsQuote')).toMatchObject({ executable: true, tool: 'glomo_api_write' });
    expect(byId.get('createDocument')).toMatchObject({ executable: false });
  });

  it('attaches the shared-calls note', async () => {
    expect((await payload<IPlan>(server.url, { flow: 'lrs-remittance' })).sharedNotes).toMatch(/^Shared calls: .*createCustomer/);
  });

  it('refuses an unknown flow', async () => {
    expect(isRefused(await plan(server.url, { flow: 'refunds' }))).toBe(true);
  });
});

describe('glomo_implementation_planner: goals', () => {
  it('returns matching flows for a goal, not a plan', async () => {
    const result = await payload<Record<string, unknown> & { candidates: { id: string }[] }>(server.url, { goal: 'send a payout' });
    expect(result.status).toBe('select_flow');
    expect(result.candidates[0].id).toBe('payouts');
    expect(result).not.toHaveProperty('variants');
  });

  it('says there is no authored flow when nothing matches, and lists the flows', async () => {
    const result = await payload<{ status: string; flows: { id: string }[] }>(server.url, { goal: 'zzqx quantum flux' });
    expect(result.status).toBe('no_authored_flow');
    expect(result.flows.map((flow) => flow.id)).toEqual(FLOW_IDS);
  });

  it('refuses a call with neither a flow nor a goal', async () => {
    expect(isRefused(await plan(server.url, {}))).toBe(true);
  });

  it('refuses a goal above the maximum length', async () => {
    expect(isRefused(await plan(server.url, { goal: 'a'.repeat(501) }))).toBe(true);
  });
});

describe('glomo_implementation_planner: fails closed', () => {
  it('reports not_available when the server has no docs corpus', async () => {
    const bare = await start();
    const result = await payload<Record<string, unknown>>(bare.url, { goal: 'send a payout' });
    expect(result.status).toBe('not_available');
    expect(Object.keys(result).sort()).toEqual(['goal', 'message', 'status', 'use']);
  });

  for (const [label, mutate] of [
    ['a step in neither format', (content: string) => content.replace('`createQuote` `POST /quotes` —', '`createQuote` POST /quotes —')],
    [
      'a variant without its Full guide link',
      (content: string) => content.replace('Full guide: [Send payouts with the API](https://docs.glomo.one/payout/set-up)', ''),
    ],
    ['a skipped step number', (content: string) => content.replace('2. `getBeneficiaryByIdV2`', '3. `getBeneficiaryByIdV2`')],
    ['a flow section without its ### variant heading', (content: string) => content.replace(/(## Payouts\n[\s\S]*?)### Calls, in order\n/, '$1')],
    ['no Shared calls line', (content: string) => content.replace(/^Shared calls: .*$/m, '')],
    ['two flows with the same id', (content: string) => content.replace('## Bank transfer collection', '## Payouts')],
  ] as const) {
    it(`reports not_available rather than a partial plan when the page has ${label}`, async () => {
      const mutated = mutate(guidePage.content);
      expect(mutated).not.toBe(guidePage.content);
      const broken = await start(writeCorpus(withGuideContent(mutated), label.replace(/\W+/g, '-')));
      const result = await payload<{ status: string }>(broken.url, { goal: 'send a payout' });
      expect(result.status).toBe('not_available');
    });
  }
});

describe('build check: authored flows against the spec', () => {
  function specFromGuide(): Map<string, ISpecOperation> {
    const operations = new Map<string, ISpecOperation>();
    for (const flow of flowGuideFromCorpus(corpus).flows) {
      for (const variant of flow.variants) {
        for (const step of variant.steps) if (step.kind === 'api') operations.set(step.operationId, { method: step.method, path: step.path });
      }
    }
    return operations;
  }

  it('passes when every step matches the spec', () => {
    expect(findFlowProblems(flowGuideFromCorpus(corpus), specFromGuide())).toEqual([]);
  });

  it('fails on an operationId that is not in the spec', () => {
    const operations = specFromGuide();
    operations.delete('createQuote');
    expect(findFlowProblems(flowGuideFromCorpus(corpus), operations).join('\n')).toMatch(/createQuote is not in the published spec/);
  });

  it('fails when a step names the wrong method or path', () => {
    const operations = specFromGuide();
    operations.set('createPayout', { method: 'POST', path: '/v2/payouts' });
    expect(findFlowProblems(flowGuideFromCorpus(corpus), operations).join('\n')).toMatch(/createPayout is POST \/v2\/payouts in the spec/);
  });

  it('reads operations from a spec document by operationId, method and path', () => {
    const operations = specOperations({
      paths: { '/payouts': { post: { operationId: 'createPayout' }, parameters: [] }, '/payouts/{id}': { get: { operationId: 'getPayoutById' } } },
    });
    expect([...operations]).toEqual([
      ['createPayout', { method: 'POST', path: '/payouts' }],
      ['getPayoutById', { method: 'GET', path: '/payouts/{id}' }],
    ]);
  });

  it('the build step accepts the recorded docs when they match the spec', async () => {
    await withCassette('docs-corpus.json', async () => {
      const { guide } = await buildCheckedCorpus(specFromGuide());
      expect(guide.flows.map((flow) => flow.id)).toEqual(FLOW_IDS);
    });
  });

  it('the build step fails when a step names an operation the spec lacks', async () => {
    const operations = specFromGuide();
    operations.delete('createQuote');
    await withCassette('docs-corpus.json', async () => {
      await expect(buildCheckedCorpus(operations)).rejects.toThrow(/createQuote is not in the published spec/);
    });
  });
});
