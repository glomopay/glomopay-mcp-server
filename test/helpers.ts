import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { sign, type KeyObject } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';

import nock from 'nock';

import { createApp } from '@/core/app/app.module';

export const API_BASE = process.env.GLOMO_API_HOST ?? 'https://sandbox-api.glomopay.com';
export const isRecording = process.env.NOCK_BACK_MODE === 'record';

export const TEST_AUDIENCE = 'glomo-mcp';
const testKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_PUBLIC_KEY = testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// The server verifies against the real glomo key in record mode; test-signed
// tokens are only accepted in lockdown replay. Re-recording execution cassettes
// therefore needs a real MCP credential issued by glomo, not a test token.
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

export interface ITestServerOptions {
  specPath?: string;
  docsCorpusPath?: string;
  authPublicKey?: string;
  authAudience?: string;
  apiHost?: string;
  downstreamTimeoutMs?: number;
  /** Environment the app is created under; restored afterwards. */
  env?: Record<string, string | undefined>;
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  return run().finally(() => apply(previous));
}

export async function startTestServer(options: ITestServerOptions = {}): Promise<ITestServer> {
  const app = await withEnv(options.env ?? {}, () =>
    createApp({
      specPath: options.specPath ?? FIXTURE_SPEC,
      apiHost: options.apiHost ?? API_BASE,
      docsCorpusPath: options.docsCorpusPath,
      authPublicKey: 'authPublicKey' in options ? options.authPublicKey : AUTH_PUBLIC_KEY,
      authAudience: 'authAudience' in options ? options.authAudience : AUTH_AUDIENCE,
      analyticsFlushIntervalMs: 5,
      downstreamTimeoutMs: options.downstreamTimeoutMs,
    }),
  );
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

// Sign an MCP credential the way glomo will: RS256, aud = the MCP audience, no
// scope or purpose claim (every credential is read_write for now). Callers override
// any claim via `extra` (e.g. a wrong aud, a foreign key).
export function jwtToken(env?: string, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { aud: TEST_AUDIENCE, iat: now, exp: now + 3600, ...(env ? { env } : {}), ...extra };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), testKeyPair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export const jwt = jwtToken;

// Sign an arbitrary header/payload with the test key, for cases jwtToken can't
// express: a pinned-algorithm mismatch (e.g. RS512), or a missing required claim.
export function signTestToken(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }): string {
  const digest = header.alg === 'RS512' ? 'RSA-SHA512' : 'RSA-SHA256';
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto.sign(digest, Buffer.from(signingInput), testKeyPair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export interface IToolResponse {
  result?: { content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

async function rpc(url: string, method: string, params: unknown, bearer?: string, extraHeaders: Record<string, string> = {}): Promise<IToolResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const text = await response.text();
  const line = text.split('\n').find((entry) => entry.startsWith('data:'));
  return JSON.parse((line ?? text).replace(/^data:\s*/, ''));
}

export function callTool(url: string, name: string, args: unknown, bearer?: string, headers?: Record<string, string>): Promise<IToolResponse> {
  return rpc(url, 'tools/call', { name, arguments: args }, bearer, headers);
}

export function initialize(url: string, clientInfo: unknown, bearer: string, headers?: Record<string, string>): Promise<IToolResponse> {
  return rpc(
    url,
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, ...(clientInfo === undefined ? {} : { clientInfo }) },
    bearer,
    headers,
  );
}

/** An RS256 JWT shaped like a glomo private API key, signed with a throwaway test key. */
export function signApiKey(
  claims: Record<string, unknown>,
  privateKey: KeyObject,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' },
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

export const MIXPANEL_API = 'https://api.mixpanel.com';

export interface IMixpanelEvent {
  event: string;
  properties: Record<string, unknown>;
}

export interface IMixpanelCapture {
  events: IMixpanelEvent[];
  /** The raw request bodies and query strings, for asserting nothing leaks. */
  requests: { query: URLSearchParams; body: string }[];
  scope: nock.Scope;
  waitFor: (count: number, timeoutMs?: number) => Promise<IMixpanelEvent[]>;
}

/**
 * Intercepts Mixpanel's ingestion endpoint and decodes what the server sends.
 * Never record a cassette against Mixpanel: it would write to the real project.
 */
export function captureMixpanel(reply: { status?: number; body?: string; delayMs?: number; networkError?: string } = {}): IMixpanelCapture {
  const events: IMixpanelEvent[] = [];
  const requests: { query: URLSearchParams; body: string }[] = [];
  const record = (uri: string, body: unknown) => {
    const raw = String(body);
    requests.push({ query: new URL(uri, MIXPANEL_API).searchParams, body: raw });
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(raw.replace(/^data=/, '')), 'base64').toString('utf8')) as IMixpanelEvent[];
    events.push(...decoded);
  };

  const interceptor = nock(MIXPANEL_API).persist().post('/track').query(true);
  if (reply.delayMs) interceptor.delay(reply.delayMs);
  const scope = reply.networkError
    ? interceptor.replyWithError(reply.networkError)
    : interceptor.reply((uri, body) => {
        record(uri, body);
        return [reply.status ?? 200, reply.body ?? '1'];
      });
  if (reply.networkError) scope.on('request', (req: { path: string }, _interceptor: unknown, body: string) => record(req.path, body));

  const waitFor = async (count: number, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (events.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    return events;
  };

  return { events, requests, scope, waitFor };
}

/**
 * A real TCP endpoint that misbehaves the way a broken upstream does: it either
 * never answers or drops the connection as soon as it opens.
 */
export async function startBrokenUpstream(behaviour: 'silent' | 'reset'): Promise<{ origin: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const upstream = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (behaviour === 'reset') socket.resetAndDestroy();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        upstream.close(() => resolve());
      }),
  };
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resultText(response: IToolResponse): string {
  return response.result?.content?.[0]?.text ?? '';
}

export function isRefused(response: IToolResponse): boolean {
  return Boolean(response.error) || response.result?.isError === true;
}
