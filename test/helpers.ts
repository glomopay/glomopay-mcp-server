import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';

import nock from 'nock';

import { createApp } from '@/core/app/app.module';

export const API_BASE = process.env.GLOMO_API_HOST ?? 'https://sandbox-api.glomopay.com';
export const SANDBOX_TOKEN = process.env.GLOMO_SANDBOX_TOKEN ?? jwtToken('sandbox');
export const isRecording = process.env.NOCK_BACK_MODE === 'record';

const FIXTURE_SPEC = path.resolve(process.cwd(), 'test/fixtures/openapi.json');

nock.back.fixtures = path.resolve(process.cwd(), 'test/fixtures/cassettes');
nock.back.setMode((process.env.NOCK_BACK_MODE as nock.BackMode) || 'lockdown');

export interface ITestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<ITestServer> {
  const app = await createApp({ specPath: FIXTURE_SPEC, apiHost: API_BASE });
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

export function cassetteExists(name: string): boolean {
  return existsSync(path.join(nock.back.fixtures as string, name));
}

export async function withCassette(name: string, run: () => Promise<void>): Promise<void> {
  const { nockDone } = await nock.back(name, {
    afterRecord: (defs) =>
      defs.map((def) => {
        const headers = (def as { reqheaders?: Record<string, unknown> }).reqheaders;
        if (headers) delete headers.authorization;
        return def;
      }),
  });
  try {
    await run();
  } finally {
    nockDone();
  }
}

export function jwtToken(env?: string, extra: Record<string, unknown> = {}): string {
  const payload = { ...(env ? { env } : {}), ...extra };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
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
