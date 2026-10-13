import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { initialize, SANDBOX_TOKEN, startTestServer, type ITestServer, type ITestServerOptions } from './helpers';

const FIXTURES = path.resolve(__dirname, 'fixtures/server-card');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(path.join(FIXTURES, 'schema.json'), 'utf8')), 'schema.json');
const validateCard = ajv.getSchema('schema.json#/$defs/ServerCard')!;

function examples(kind: 'valid' | 'invalid'): [string, unknown][] {
  const dir = path.join(FIXTURES, kind);
  return readdirSync(dir).map((file) => [file, JSON.parse(readFileSync(path.join(dir, file), 'utf8'))]);
}

const started: ITestServer[] = [];

async function server(options: ITestServerOptions = {}): Promise<ITestServer> {
  const app = await startTestServer(options);
  started.push(app);
  return app;
}

const cardUrl = (app: ITestServer) => `${app.url}/server-card`;

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

afterAll(() => {
  nock.enableNetConnect();
});

describe('server card schema fixtures', () => {
  // Proves the validator below can fail: if the schema stopped loading, every card would pass.
  it.each(examples('valid'))('accepts the upstream valid example %s', (_file, card) => {
    expect(validateCard(card), JSON.stringify(validateCard.errors)).toBe(true);
  });

  it.each(examples('invalid'))('rejects the upstream invalid example %s', (_file, card) => {
    expect(validateCard(card)).toBe(false);
  });
});

describe('GET /mcp/server-card', () => {
  it('serves a SEP-2127 server card without a credential', async () => {
    const app = await server();
    const response = await fetch(cardUrl(app), { headers: { Accept: 'application/mcp-server-card+json' } });
    const card = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/mcp-server-card\+json\b/);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(validateCard(card), JSON.stringify(validateCard.errors)).toBe(true);
    expect(card.remotes).toEqual([expect.objectContaining({ type: 'streamable-http', url: 'https://mcp.glomo.one/mcp' })]);
  });

  it('describes the server initialize reports', async () => {
    const app = await server();
    const card = await (await fetch(cardUrl(app))).json();
    const init = (await initialize(app.url, { name: 'claude-code', version: '2.0.14' }, SANDBOX_TOKEN)) as {
      result?: { protocolVersion?: string; serverInfo?: { version?: string } };
    };

    expect(card.version).toBe(init.result?.serverInfo?.version);
    expect(card.remotes[0].supportedProtocolVersions).toContain(init.result?.protocolVersion);
  });

  it('marks the credential optional, since discovery tools work without one', async () => {
    const app = await server();
    const card = await (await fetch(cardUrl(app))).json();

    expect(card.remotes[0].headers).toEqual([expect.objectContaining({ name: 'Authorization', isRequired: false, isSecret: true })]);
  });

  it('answers HEAD with the card headers and no body', async () => {
    const app = await server();
    const response = await fetch(cardUrl(app), { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/mcp-server-card\+json\b/);
    expect(await response.text()).toBe('');
  });

  it('sits behind the flood guard', async () => {
    const app = await server({ rateLimit: { floodPerMinute: 2 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(cardUrl(app))).status);

    expect(statuses).toEqual([200, 200, 429]);
  });
});
