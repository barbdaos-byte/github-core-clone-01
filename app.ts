// The forge server: one in-memory store, four surfaces.
//
//   GET  /healthz                    the env's boot probe (no auth)
//   /api/v3/*                        REST v3 (src/rest.ts)
//   /api/graphql                     GraphQL v4 (src/graphql.ts)
//   /mcp                             MCP, JSON-RPC 2.0 (src/mcp.ts)
//   /{owner}/{repo}.git/*            git smart HTTP (src/git.ts)
//
// Anything else is a JSON 404, never HTML. A handler that throws answers a
// JSON 500 and never leaks a stack.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git.ts';
import { handleGraphql } from './src/graphql.ts';
import { buildContext, sendError, sendJson } from './src/http.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { ForgeStore } from './src/store.ts';
import { viewerLogin } from './src/viewer.ts';

export { viewerLogin };

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new ForgeStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store).catch(() => {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"message":"Internal Server Error"}\n');
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: ForgeStore): Promise<void> {
  const ctx = await buildContext(req, res);
  try {
    // The env's boot check calls this twice: 200 {"ok":true}, no token.
    if (ctx.method === 'GET' && ctx.path === '/healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }
    if (handleRest(ctx, store)) return;
    if (handleGraphql(ctx, store)) return;
    if (handleMcp(ctx, store)) return;
    if (handleGit(ctx, store)) return;
    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    if (!res.headersSent && !res.writableEnded) {
      sendError(ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
    }
  }
}
