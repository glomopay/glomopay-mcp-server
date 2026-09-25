import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, isRefused, resultText, startTestServer, type ITestServer, type IToolResponse } from './helpers';

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

function sample(operationId: string, language?: string): Promise<IToolResponse> {
  const args = language === undefined ? { operationId } : { operationId, language };
  return callTool(server.url, 'glomo_sample_request', args, 'test');
}
async function sampleText(operationId: string, language?: string): Promise<string> {
  return resultText(await sample(operationId, language));
}

describe('glomo_sample_request', () => {
  it('generates a cURL sample with the real URL and the request example body', async () => {
    const text = await sampleText('createPayout');
    expect(text).toContain("curl -X POST 'https://api.glomopay.com/api/v1/payouts'");
    expect(text).toContain("-H 'Content-Type: application/json'");
    expect(text).toContain('invoice_number'); // optional field present only when the full request example is used
  });

  it('defaults to cURL when no language is given', async () => {
    expect(await sampleText('getCustomers')).toContain('curl -X GET');
  });

  it('renders an expandable credential placeholder per language', async () => {
    expect(await sampleText('createPayout')).toContain('-H "Authorization: Bearer $GLOMO_API_KEY"');
    expect(await sampleText('createPayout', 'python')).toContain('f"Bearer {os.environ[\'GLOMO_API_KEY\']}"');
    expect(await sampleText('createPayout', 'node')).toContain('`Bearer ${process.env.GLOMO_API_KEY}`');
  });

  it('fills a path parameter from the schema example, prefixed and unencoded', async () => {
    const text = await sampleText('cancelPayout');
    expect(text).toContain('/api/v1/payouts/payout_');
    expect(text).toContain('/cancel');
    expect(text).not.toContain('{id}');
    expect(text).not.toContain('<id>');
    expect(text).not.toContain('%3C');
  });

  it('omits a request body for a GET operation', async () => {
    const text = await sampleText('getCustomers');
    expect(text).not.toContain(" -d '");
    expect(text).not.toContain(' -F ');
  });

  it('includes the query string for a GET with query params', async () => {
    expect(await sampleText('getPayments')).toContain('customer_id=');
  });

  it('adds request_id where the schema declares it, and not where it does not', async () => {
    expect(await sampleText('createOrder')).toContain('request_id');
    expect(await sampleText('createPayin')).not.toContain('request_id');
  });

  it('emits required fields for a synthesised body', async () => {
    expect(await sampleText('createSubscription')).toContain('customer_id');
  });

  it('renders multipart operations as form fields, not JSON', async () => {
    const text = await sampleText('createDocument');
    expect(text).toContain("-F 'file=@./file'");
    expect(text).toContain("-F 'document_name=");
    expect(text).not.toContain(" -d '");
    expect(text).not.toContain('multipart/form-data');
  });

  it('renders multipart in Python with files and data', async () => {
    const text = await sampleText('createDocument', 'python');
    expect(text).toContain('files = {');
    expect(text).toContain('open(');
    expect(text).toContain('data = {');
  });

  it('renders multipart in Node with FormData', async () => {
    const text = await sampleText('createDocument', 'node');
    expect(text).toContain('new FormData()');
    expect(text).toContain('openAsBlob(');
  });

  it('drops read-only fields and keeps concrete examples through allOf', async () => {
    const text = await sampleText('createPrice');
    expect(text).not.toContain('"created_at"');
    expect(text).not.toContain('"updated_at"');
    expect(text).toContain('"fees_amount": 1000');
  });

  it('renders Python literals (True/False/None), not JSON', async () => {
    expect(await sampleText('createSubscription', 'python')).toMatch(/\b(True|False|None)\b/);
  });

  it('renders a JSON body for a Node POST', async () => {
    expect(await sampleText('createOrder', 'node')).toContain('body: JSON.stringify(');
  });

  it('generates a sample for a documentation-only operation', async () => {
    const response = await sample('rotateApiKey');
    expect(isRefused(response)).toBe(false);
    expect(resultText(response)).toContain('curl -X');
  });

  it('errors on an unknown operationId', async () => {
    const response = await sample('doesNotExist');
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toMatch(/unknown operationId/i);
  });

  it('rejects an operationId above the maximum length as invalid input', async () => {
    const response = await sample('a'.repeat(101));
    expect(response.error?.message ?? '').toMatch(/invalid arguments/i);
    expect(response.error?.message ?? '').toContain('operationId');
  });

  it('rejects an unsupported language as invalid input', async () => {
    const response = await sample('createPayout', 'ruby');
    expect(response.error?.message ?? '').toMatch(/invalid arguments/i);
    expect(response.error?.message ?? '').toContain('language');
  });
});
