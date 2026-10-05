import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { initialize, startTestServer, SANDBOX_TOKEN, type ITestServer } from './helpers';

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
});

describe('server identity', () => {
  it('introduces itself to clients as glomo', async () => {
    const response = (await initialize(server.url, { name: 'claude-code', version: '2.0.14' }, SANDBOX_TOKEN)) as {
      result?: { serverInfo?: { name?: string } };
    };

    expect(response.result?.serverInfo?.name).toBe('glomo');
  });
});
