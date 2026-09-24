import path from 'node:path';
import type { Server } from 'node:http';

import { createApp } from '@/core/app/app.module';

export const API_BASE = 'https://sandbox.glomo.test';

const FIXTURE_SPEC = path.resolve(process.cwd(), 'test/fixtures/openapi.json');

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

export function jwt(env?: string, extra: Record<string, unknown> = {}): string {
  const payload = { ...(env ? { env } : {}), ...extra };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

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

export function refusalReason(response: IToolResponse): string {
  return response.error?.message ?? resultText(response);
}
