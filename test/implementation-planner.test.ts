import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, isRefused, resultText, startTestServer, type ITestServer, type IToolResponse } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');

interface IPlannerResponse {
  status: string;
  goal: string;
  message: string;
  use: { tools: string[]; skills: string };
}

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer({ specPath: DISCOVERY_SPEC });
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
});

function plan(goal: string): Promise<IToolResponse> {
  return callTool(server.url, 'glomo_implementation_planner', { goal }, 'test');
}

describe('glomo_implementation_planner (placeholder)', () => {
  it('reports that it is not available yet and points to the alternatives', async () => {
    const response = await plan('accept card payments from US customers');
    expect(isRefused(response)).toBe(false);
    const payload = JSON.parse(resultText(response)) as IPlannerResponse;
    expect(payload.status).toBe('not_available');
    expect(payload.use.tools).toContain('glomo_docs_search');
    expect(payload.use.skills).toContain('/.well-known/skills/');
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
