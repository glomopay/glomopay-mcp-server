import path from 'node:path';
import os from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, type ICorpusPage } from '@/core/docs/docs.module';
import { callTool, isRefused, resultText, startTestServer, withCassette, type ITestServer, type IToolResponse } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');
const SKILLS_URL = 'https://docs.glomo.one/.well-known/skills/index.json';

interface IPlannerResponse {
  status: string;
  goal: string;
  message: string;
  use: { tools: string[]; skills: string };
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

function plan(goal: string): Promise<IToolResponse> {
  return callTool(server.url, 'glomo_implementation_planner', { goal }, 'test');
}

async function toolNames(): Promise<string[]> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await response.text();
  const line = text.split('\n').find((entry) => entry.startsWith('data:'));
  const parsed = JSON.parse((line ?? text).replace(/^data:\s*/, '')) as { result?: { tools?: { name: string }[] } };
  return (parsed.result?.tools ?? []).map((tool) => tool.name);
}

describe('glomo_implementation_planner (placeholder)', () => {
  it('reports that it is not available yet and points to the alternatives', async () => {
    const response = await plan('accept card payments from US customers');
    expect(isRefused(response)).toBe(false);
    const payload = JSON.parse(resultText(response)) as IPlannerResponse;
    expect(payload.status).toBe('not_available');
    expect(payload.use.tools).toContain('glomo_docs_search');
  });

  it('returns exactly the placeholder keys and no plan-shaped content', async () => {
    const payload = JSON.parse(resultText(await plan('accept card payments'))) as { use: Record<string, unknown> };
    expect(Object.keys(payload).sort()).toEqual(['goal', 'message', 'status', 'use']);
    expect(Object.keys(payload.use).sort()).toEqual(['skills', 'tools']);
  });

  it('pins the exact skills index URL', async () => {
    const payload = JSON.parse(resultText(await plan('send a payout'))) as IPlannerResponse;
    expect(payload.use.skills).toBe(SKILLS_URL);
  });

  it('names only tools that exist on the server', async () => {
    const registered = new Set(await toolNames());
    const payload = JSON.parse(resultText(await plan('refund a payment'))) as IPlannerResponse;
    for (const tool of payload.use.tools) expect(registered).toContain(tool);
  });

  it('echoes the goal back', async () => {
    const payload = JSON.parse(resultText(await plan('send a payout'))) as IPlannerResponse;
    expect(payload.goal).toBe('send a payout');
  });

  it('refuses an empty goal', async () => {
    expect(isRefused(await plan(''))).toBe(true);
  });

  it('refuses a goal above the maximum length', async () => {
    expect(isRefused(await plan('a'.repeat(501)))).toBe(true);
  });
});
