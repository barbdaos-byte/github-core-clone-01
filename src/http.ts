// HTTP plumbing: request context, JSON bodies, JSON replies, auth.
//
// The wire contract (RULES.txt): every REST reply is application/json, never
// HTML, and carries a non-empty X-GitHub-Request-Id; an error carries a JSON
// body with a string message; a request without a Bearer token is 401; a
// malformed JSON body is 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nextRequestId, safeText } from './util.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  requestId: string;
  /** The Bearer token presented, or null when none was. */
  token: string | null;
  /** The raw request body bytes (used by the git packfile surface). */
  rawBody: Buffer;
  /** The parsed JSON body, or undefined when the request had no body. */
  body: unknown;
  /** True when the body was present but not valid JSON. */
  bodyMalformed: boolean;
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : match[1] as string;
}

/** Read the request body (up to 8 MiB, the entry's per-file cap). */
async function readBody(req: IncomingMessage): Promise<{ buffer: Buffer; malformed: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 8_388_608) return { buffer: Buffer.alloc(0), malformed: true };
    chunks.push(buffer);
  }
  return { buffer: Buffer.concat(chunks), malformed: false };
}

/** Build the request context, parsing a JSON body when one is present. */
export async function buildContext(req: IncomingMessage, res: ServerResponse): Promise<RequestContext> {
  const { path, query } = pathOf(req);
  const method = req.method ?? 'GET';
  const requestId = nextRequestId();
  const token = tokenOf(req);
  let body: unknown;
  let bodyMalformed = false;
  let rawBody = Buffer.alloc(0);
  // Git smart HTTP carries binary packfiles: keep the raw bytes and never
  // try to parse them as JSON. Every other mutating method gets a JSON body.
  const isGit = /\.git\//.test(path);
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && !isGit) {
    const { buffer, malformed } = await readBody(req);
    rawBody = buffer;
    if (malformed) {
      bodyMalformed = true;
    } else if (buffer.toString('utf8').trim() !== '') {
      try {
        body = JSON.parse(buffer.toString('utf8')) as unknown;
      } catch {
        bodyMalformed = true;
      }
    }
  } else if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && isGit) {
    const { buffer, malformed } = await readBody(req);
    rawBody = buffer;
    bodyMalformed = malformed;
  }
  return { req, res, method, path, query, requestId, token, rawBody, body, bodyMalformed };
}

/** Send a JSON reply with the request-id header always present. */
export function sendJson(
  ctx: RequestContext,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(buf);
}

/** Send a JSON error: {message} with a string message. */
export function sendError(ctx: RequestContext, status: number, message: string): void {
  sendJson(ctx, status, { message: safeText(message) });
}

/** Send a 204 with no body (DELETE repo), still carrying the request id. */
export function sendNoContent(ctx: RequestContext): void {
  ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** Send raw bytes with an explicit content type (git smart HTTP). */
export function sendBytes(
  ctx: RequestContext,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(body);
}

/**
 * The bearer check for protected surfaces. When MAKEFUN_SHOP_TOKEN is set
 * (every trial), the presented token must equal it; when it is unset (local
 * development), any non-empty Bearer token is accepted. No token is 401.
 * The expected token is read once at module load: the trial sets it before
 * the process starts and nothing in the server ever changes it.
 */
const EXPECTED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

export function requireAuth(ctx: RequestContext): boolean {
  if (ctx.token === null || ctx.token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return ctx.token === EXPECTED_TOKEN;
}

/** The parsed body as an object, or null when it is not an object. */
export function bodyObject(ctx: RequestContext): Record<string, unknown> | null {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return null;
  return ctx.body as Record<string, unknown>;
}

export function bodyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function bodyBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function bodyNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Parse a positive integer query parameter with a default. */
export function queryInt(ctx: RequestContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
