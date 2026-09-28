import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { sign, type KeyObject } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
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
  analyticsTimeoutMs?: number;
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
      analyticsTimeoutMs: options.analyticsTimeoutMs,
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

/** An RS256 JWT signed with the given key, e.g. a foreign key the server must not accept. */
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
export function captureMixpanel(reply: { status?: number; body?: string } = {}): IMixpanelCapture {
  const events: IMixpanelEvent[] = [];
  const requests: { query: URLSearchParams; body: string }[] = [];

  const scope = nock(MIXPANEL_API)
    .persist()
    .post('/track')
    .query(true)
    .reply((uri, body) => {
      const raw = String(body);
      requests.push({ query: new URL(uri, MIXPANEL_API).searchParams, body: raw });
      const data = new URLSearchParams(raw).get('data') ?? '';
      events.push(...(JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as IMixpanelEvent[]));
      return [reply.status ?? 200, reply.body ?? '1'];
    });

  const waitFor = async (count: number, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (events.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    return events;
  };

  return { events, requests, scope, waitFor };
}

export interface IUpstreamRequest {
  method: string;
  path: string;
  body: string;
}

export interface IFakeUpstream {
  origin: string;
  /** Connections accepted so far, and the most that were open at once. */
  stats: { connections: number; open: number; maxOpen: number; answered: number };
  requests: IUpstreamRequest[];
  close: () => Promise<void>;
}

export const UPSTREAM_REQUEST_ID = 'req_7f3c2a1b';

/** Records the request line of each HTTP request a raw socket receives (body chunks are skipped). */
function recordRawRequest(requests: IUpstreamRequest[], chunk: string): void {
  const [method, path] = chunk.split('\r\n')[0].split(' ');
  if (/^[A-Z]+$/.test(method ?? '') && path?.startsWith('/')) requests.push({ method, path, body: '' });
}

/**
 * A real local endpoint standing in for a misbehaving or specific upstream:
 * - `silent` accepts connections, records each request line, and never answers;
 * - `reset` drops each connection as soon as it opens;
 * - `status` answers over HTTP with the status named in the path (`..._status_503`),
 *   otherwise 200 (GET) or 201, after `delayMs`, with an `x-request-id` header and `body`
 *   (a string as-is, anything else as JSON).
 */
export async function startBrokenUpstream(
  behaviour: 'silent' | 'reset' | 'status',
  options: { body?: unknown; delayMs?: number } = {},
): Promise<IFakeUpstream> {
  const sockets = new Set<Socket>();
  const stats = { connections: 0, open: 0, maxOpen: 0, answered: 0 };
  const requests: IUpstreamRequest[] = [];

  const track = (socket: Socket) => {
    sockets.add(socket);
    stats.connections += 1;
    stats.open += 1;
    stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    socket.on('close', () => {
      sockets.delete(socket);
      stats.open -= 1;
    });
  };

  const upstream =
    behaviour === 'status'
      ? createHttpServer((req, res) => {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            requests.push({ method: req.method ?? '', path: req.url ?? '', body });
            const named = /_status_(\d{3})/.exec(req.url ?? '');
            const status = named ? Number(named[1]) : req.method === 'GET' ? 200 : 201;
            setTimeout(() => {
              const text = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {});
              res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': UPSTREAM_REQUEST_ID });
              res.end(text, () => (stats.answered += 1));
            }, options.delayMs ?? 0);
          });
        })
      : createServer((socket) => {
          if (behaviour === 'reset') socket.resetAndDestroy();
          else socket.on('data', (chunk) => recordRawRequest(requests, String(chunk)));
        });
  upstream.on('connection', track);

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    stats,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        upstream.close(() => resolve());
      }),
  };
}

/** Sends several JSON-RPC requests in one POST and waits for the whole reply. */
export async function rpcBatch(url: string, messages: { method: string; params: unknown }[], bearer: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(messages.map((message, index) => ({ jsonrpc: '2.0', id: index + 1, ...message }))),
  });
  return response.text();
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
