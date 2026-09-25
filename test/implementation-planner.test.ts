import path from 'node:path';
import os from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, type ICorpusPage } from '@/core/docs/docs.module';
import { callTool, isRefused, resultText, startTestServer, withCassette, type ITestServer, type IToolResponse } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');

interface IPlanStep {
  step: number;
  operationId: string;
  method: string;
  executable: boolean;
  tool?: string;
  dependsOn: string[];
}
interface IPlan {
  goal: string;
  steps: IPlanStep[];
  docs: { title: string; url: string; anchor: string }[];
}

let server: ITestServer;
let corpusPath: string;

beforeAll(async () => {
  let corpus: ICorpusPage[] = [];
  await withCassette('docs-corpus.json', async () => {
    corpus = await buildCorpus();
  });
  corpusPath = path.join(os.tmpdir(), `planner-corpus-${process.pid}.json`);
  writeFileSync(corpusPath, JSON.stringify(corpus));
  server = await startTestServer({ specPath: DISCOVERY_SPEC, docsCorpusPath: corpusPath });
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
  rmSync(corpusPath, { force: true });
});

function plan(goal: string, limit?: number): Promise<IToolResponse> {
  const args = limit === undefined ? { goal } : { goal, limit };
  return callTool(server.url, 'glomo_implementation_planner', args, 'test');
}
async function planData(goal: string, limit?: number): Promise<IPlan> {
  return JSON.parse(resultText(await plan(goal, limit))) as IPlan;
}

describe('glomo_implementation_planner', () => {
  it('sequences a dependent operation after the operation that produces its id', async () => {
    const { steps } = await planData('create and cancel a payout');
    const ids = steps.map((s) => s.operationId);
    expect(ids).toContain('createPayout');
    expect(ids.indexOf('cancelPayout')).toBeGreaterThan(ids.indexOf('createPayout'));
    expect(steps.find((s) => s.operationId === 'cancelPayout')?.dependsOn).toContain('createPayout');
  });

  it('tags each executable step with its tool', async () => {
    const { steps } = await planData('create and cancel a payout');
    for (const step of steps) {
      if (step.executable) expect(step.tool).toBe(step.method === 'GET' ? 'glomo_api_read' : 'glomo_api_write');
      else expect(step.tool).toBeUndefined();
    }
  });

  it('returns cited documentation links', async () => {
    const { docs } = await planData('payin purpose code');
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].url).toContain('docs.glomo.one');
    expect(docs[0].anchor).toBeTruthy();
  });

  it('honours the limit', async () => {
    const { steps } = await planData('payout', 1);
    expect(steps).toHaveLength(1);
  });

  it('includes a documentation-only operation, flagged not executable', async () => {
    const step = (await planData('rotate api key')).steps.find((s) => s.operationId === 'rotateApiKey');
    expect(step).toBeDefined();
    expect(step?.executable).toBe(false);
    expect(step?.tool).toBeUndefined();
  });

  it('refuses an empty goal', async () => {
    expect(isRefused(await plan(''))).toBe(true);
  });

  it('refuses a goal above the maximum length', async () => {
    expect(isRefused(await plan('a'.repeat(501)))).toBe(true);
  });

  it('refuses a limit above the maximum', async () => {
    expect(isRefused(await plan('payout', 21))).toBe(true);
  });
});
