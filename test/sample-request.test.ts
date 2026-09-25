import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, isRefused, resultText, startTestServer, type ITestServer } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer({ specPath: DISCOVERY_SPEC });
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
});

function sample(operationId: string, language?: string) {
  const args = language === undefined ? { operationId } : { operationId, language };
  return callTool(server.url, 'glomo_sample_request', args, 'test');
}

describe('glomo_sample_request', () => {
  it('generates a cURL sample with the real URL, body and a placeholder credential', async () => {
    const text = resultText(await sample('createPayout'));
    expect(text).toContain("curl -X POST 'https://api.glomopay.com/api/v1/payouts'");
    expect(text).toContain("-H 'Content-Type: application/json'");
    expect(text).toContain('purpose_code');
  });

  it('uses a credential placeholder, never a real token', async () => {
    const text = resultText(await sample('createPayout'));
    expect(text).toContain('Authorization: Bearer $GLOMO_API_KEY');
  });

  it('fills path parameters without leaving an unresolved template or encoding the placeholder', async () => {
    const text = resultText(await sample('cancelPayout'));
    expect(text).toContain('/api/v1/payouts/');
    expect(text).toContain('/cancel');
    expect(text).not.toContain('{id}');
    expect(text).not.toContain('%3C');
  });

  it('omits a request body for a GET operation', async () => {
    const text = resultText(await sample('getCustomers'));
    expect(text).toContain('curl -X GET');
    expect(text).not.toContain(" -d '");
  });

  it('renders a Python snippet', async () => {
    const text = resultText(await sample('createBeneficiaryV2', 'python'));
    expect(text).toContain('import requests');
    expect(text).toContain('requests.post(url, headers=headers, json=payload)');
  });

  it('renders a Node snippet', async () => {
    const text = resultText(await sample('getCustomers', 'node'));
    expect(text).toContain('await fetch(');
    expect(text).toContain('method: "GET"');
    expect(text).not.toContain('body:');
  });

  it('generates a sample for a documentation-only operation', async () => {
    const response = await sample('rotateApiKey');
    expect(isRefused(response)).toBe(false);
    expect(resultText(response)).toContain('curl -X');
  });

  it('errors on an unknown operationId', async () => {
    expect(isRefused(await sample('doesNotExist'))).toBe(true);
  });

  it('refuses an operationId above the maximum length', async () => {
    expect(isRefused(await sample('a'.repeat(101)))).toBe(true);
  });

  it('refuses an unsupported language', async () => {
    expect(isRefused(await sample('createPayout', 'ruby'))).toBe(true);
  });
});
