import type { IncomingMessage } from 'node:http';

import express, { type RequestHandler } from 'express';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

import { JSON_RPC_INVALID_REQUEST, JSON_RPC_TRANSPORT_ERROR, PARSE_ERROR, type TReject } from './json-rpc-errors';

export const BODY_LIMIT_KB = 100;

/** The MCP SDK transport accepts any Content-Type that contains this; the body parser must accept exactly the same set. */
const JSON_MEDIA_TYPE = 'application/json';

function isJsonContentType(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').includes(JSON_MEDIA_TYPE);
}

/**
 * Rejects what the transport would not accept, then parses the body under the size limit for every
 * Content-Type the transport accepts, so the transport never reads the request stream itself.
 */
export function parseJsonBody(reject: TReject): RequestHandler[] {
  const requireJson: RequestHandler = (req, res, next) => {
    if (isJsonContentType(req)) return next();
    reject(res, {
      status: 415,
      code: JSON_RPC_TRANSPORT_ERROR,
      message: 'Unsupported Media Type: Content-Type must be application/json',
      reason: 'unsupported_media_type',
    });
  };
  return [requireJson, express.json({ limit: `${BODY_LIMIT_KB}kb`, type: isJsonContentType })];
}

/**
 * Accepts a single JSON-RPC message or a batch of at most `maxBatchMessages`, and leaves the
 * messages in `res.locals.messages` for the limiters. Anything else gets a 400 with no detail.
 */
export function checkEnvelope(reject: TReject, maxBatchMessages: number): RequestHandler {
  return (req, res, next) => {
    const body: unknown = req.body;
    // An empty body is never parsed; the transport must not be left to read the stream.
    if (body === undefined) return reject(res, PARSE_ERROR);

    const messages = Array.isArray(body) ? body : [body];
    if (messages.length > maxBatchMessages) {
      return reject(res, {
        status: 400,
        code: JSON_RPC_INVALID_REQUEST,
        message: `Invalid Request: a batch may carry at most ${maxBatchMessages} messages`,
        reason: 'batch_too_large',
      });
    }
    if (messages.length === 0 || !messages.every((message) => JSONRPCMessageSchema.safeParse(message).success)) {
      return reject(res, { status: 400, code: JSON_RPC_INVALID_REQUEST, message: 'Invalid Request', reason: 'invalid_request' });
    }

    res.locals.messages = messages;
    next();
  };
}
