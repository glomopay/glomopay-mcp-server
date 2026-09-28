import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';

import nock from 'nock';

import { createApp } from '@/core/app/app.module';

export const API_BASE = process.env.GLOMO_API_HOST ?? 'https://sandbox-api.glomopay.com';
export const isRecording = process.env.NOCK_BACK_MODE === 'record';

export const TEST_AUDIENCE = 'glomo-mcp';
const testKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_PUBLIC_KEY = testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// The server verifies against the real glomo key in record mode; test-signed
// tokens are only accepted in lockdown replay.
const AUTH_PUBLIC_KEY = process.env.GLOMO_MCP_PUBLIC_KEY ?? TEST_PUBLIC_KEY;
const AUTH_AUDIENCE = process.env.GLOMO_MCP_AUDIENCE ?? TEST_AUDIENCE;

export const SANDBOX_TOKEN = process.env.GLOMO_SANDBOX_TOKEN ?? jwtToken('sandbox');

const FIXTURE_SPEC = path.resolve(__dirname, 'fixtures/openapi.json');

nock.back.fixtures = path.resolve(__dirname, 'fixtures/cassettes');
nock.back.setMode((process.env.NOCK_BACK_MODE as nock.BackMode) || 'lockdown');

export interface ITestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(options: { specPath?: string; docsCorpusPath?: string } = {}): Promise<ITestServer> {
  const app = await createApp({
    specPath: options.specPath ?? FIXTURE_SPEC,
    apiHost: API_BASE,
    docsCorpusPath: options.docsCorpusPath,
    authPublicKey: AUTH_PUBLIC_KEY,
    authAudience: AUTH_AUDIENCE,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const SENSITIVE_HEADER = /^(set-cookie|cookie|x-request-id|request-id|x-trace-id|x-amzn-.*|x-amz-.*|cf-.*|via|alt-svc|date|etag|x-runtime|server)$/i;

function isDownstream(def: nock.Definition): boolean {
  return !String(def.scope).includes('127.0.0.1');
}

function scrubString(value: string): string {
  return value.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, 'redacted@example.com');
}

function scrubBody(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubBody);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (/email/i.test(key)) out[key] = 'redacted@example.com';
      else if (/(^|_)name$/i.test(key)) out[key] = 'REDACTED';
      else if (/account.*number|iban|\bpan\b/i.test(key)) out[key] = 'REDACTED';
      else out[key] = scrubBody(val);
    }
    return out;
  }
  return value;
}

function scrubDefinition(def: nock.Definition): nock.Definition {
  const headers = (def as { rawHeaders?: Record<string, string> }).rawHeaders;
  if (headers && !Array.isArray(headers)) {
    for (const key of Object.keys(headers)) {
      if (SENSITIVE_HEADER.test(key)) delete headers[key];
    }
  }
  delete (def as { reqheaders?: unknown }).reqheaders;
  def.response = scrubBody(def.response) as nock.Definition['response'];
  return def;
}

export async function withCassette(name: string, run: () => Promise<void>): Promise<void> {
  const { nockDone } = await nock.back(name, {
    afterRecord: (defs) => defs.filter(isDownstream).map(scrubDefinition),
  });
  // nock.back clears the net-connect allow-list. When recording, allow real
  // downstream calls so they can be captured; when replaying, allow only the
  // in-process test server (the downstream stays replayed from the cassette).
  if (isRecording) nock.enableNetConnect();
  else nock.enableNetConnect('127.0.0.1');
  try {
    await run();
  } finally {
    nockDone();
  }
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Sign an MCP-purpose credential the way glomo will: RS256, aud = the MCP
// audience, scope defaulting to full access. Callers override any claim via
// `extra` (e.g. a wrong aud, a read-only scope, a foreign key).
export function jwtToken(env?: string, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { aud: TEST_AUDIENCE, scope: 'both', iat: now, exp: now + 3600, ...(env ? { env } : {}), ...extra };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), testKeyPair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export const jwt = jwtToken;

export interface IToolResponse {
  result?: { content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

export async function callTool(url: string, name: string, args: unknown, bearer?: string): Promise<IToolResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const text = await response.text();
  const line = text.split('\n').find((entry) => entry.startsWith('data:'));
  return JSON.parse((line ?? text).replace(/^data:\s*/, ''));
}

export function resultText(response: IToolResponse): string {
  return response.result?.content?.[0]?.text ?? '';
}

export function isRefused(response: IToolResponse): boolean {
  return Boolean(response.error) || response.result?.isError === true;
}
