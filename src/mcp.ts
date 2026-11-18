// MCP, Phase 4: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Two protocol eras, one endpoint (RULES.txt, checks-mcp.ts, mcp-client.ts):
//
//   modern 2026-07-28: no handshake. `server/discover` answers the server
//           identity, capabilities and supportedVersions in one result; every
//           request declares its revision in `_meta`.
//   legacy 2025-11-25 and earlier: `initialize` (echoing the negotiated
//           revision) + `notifications/initialized`, optional Mcp-Session-Id.
//
// tools/list offers the six github-mcp-server tools over the shared
// ForgeStore, so MCP, REST, GraphQL and git all read the same objects with
// the same ids. tools/call answers a tool result with content text and
// structuredContent; a tool failure is isError:true, never HTTP 500. An
// unknown tool is JSON-RPC -32602, an unknown method -32601; a body that is
// not JSON is HTTP 400 with -32700; no Authorization header is 401.

import type { RequestContext } from './http.ts';
import { requireAuth, sendError, sendJson } from './http.ts';
import { type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import { nodeId } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

/** The revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const CAPABILITIES: Record<string, unknown> = { tools: { listChanged: false } };

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- JSON views
// The same shapes REST answers (src/rest.ts), so an object created over MCP
// reads back over /api/v3 as the same object, with the same ids.

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('R', repo.full_name),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    html_url: `https://example.invalid/${repo.full_name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    size: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    forks_count: 0,
    watchers_count: 0,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('I', `${repo.full_name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: { login: issue.user.login, id: 1000, type: 'User' },
    assignee: null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: nodeId('PR', `${repo.full_name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: { login: pull.user.login, id: 1000, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The six github-mcp-server tools, in a fixed order from one constant, so
 * two tools/list answers are byte-for-byte identical. The `required` lists
 * name only properties the suite can fill (checks-mcp.ts mapArguments):
 * a required property it has no value for fails the check naming it.
 */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by issue state: open or closed.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

/** Required arguments that are missing (undefined, null, or an empty string). */
function missingArgs(args: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((name) => {
    const value = args[name];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
}

function argString(args: Record<string, unknown>, name: string, fallback = ''): string {
  return typeof args[name] === 'string' ? (args[name] as string) : fallback;
}

function argPullNumber(args: Record<string, unknown>): number | null {
  const value = args.pull_number;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** The repository a tool's owner/repo arguments name, or null when foreign or missing. */
function toolRepo(store: ForgeStore, args: Record<string, unknown>): Repo | null {
  const owner = argString(args, 'owner');
  const name = argString(args, 'repo');
  if (owner === '' || name === '') return null;
  if (owner !== store.viewer) return null;
  return store.getRepo(owner, name);
}

function toolCreateRepo(store: ForgeStore, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(args, ['name']);
  if (missing.length > 0) return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}` };
  const name = argString(args, 'name');
  const description = argString(args, 'description');
  const privateFlag = typeof args.private === 'boolean' ? args.private : false;
  const repo = store.createRepo(name, privateFlag, description);
  if (repo === null) return { ok: false, error: `Repository '${name}' already exists` };
  return { ok: true, data: repoJson(repo) };
}

function toolGetRepo(store: ForgeStore, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(args, ['owner', 'repo']);
  if (missing.length > 0) return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}` };
  const repo = toolRepo(store, args);
  if (repo === null) return { ok: false, error: `Repository not found: ${argString(args, 'owner')}/${argString(args, 'repo')}` };
  return { ok: true, data: repoJson(repo) };
}

function toolCreateIssue(store: ForgeStore, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(args, ['owner', 'repo', 'title']);
  if (missing.length > 0) return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}` };
  const repo = toolRepo(store, args);
  if (repo === null) return { ok: false, error: `Repository not found: ${argString(args, 'owner')}/${argString(args, 'repo')}` };
  const issue = repo.createIssue(argString(args, 'title'), argString(args, 'body'));
  return { ok: true, data: issueJson(repo, issue) };
}

function toolListIssues(store: ForgeStore, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(args, ['owner', 'repo']);
  if (missing.length > 0) return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}` };
  const repo = toolRepo(store, args);
  if (repo === null) return { ok: false, error: `Repository not found: ${argString(args, 'owner')}/${argString(args, 'repo')}` };
  const state = argString(args, 'state').toLowerCase();
  const issues = state === 'open' || state === 'closed'
    ? repo.issues.filter((issue) => issue.state === state)
    : repo.issues;
  return { ok: true, data: issues.map((issue) => issueJson(repo, issue)) };
}

function toolCreatePullRequest(store: ForgeStore, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
  if (missing.length > 0) return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}` };
  const repo = toolRepo(store, args);
  if (repo === null) return { ok: false, error: `Repository not found: ${argString(args, 'owner')}/${argString(args, 'repo')}` };
  const result = repo.createPull(argString(args, 'head'), argString(args, 'base'), argString(args, 'title'), argString(args, 'body'));
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: pullJson(repo, result.pull) };
}

function toolMergePullRequest(store: ForgeStore, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(args, ['owner', 'repo']);
  if (missing.length > 0) return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}` };
  const pullNumber = argPullNumber(args);
  if (pullNumber === null) return { ok: false, error: 'Missing required argument(s): pull_number' };
  const repo = toolRepo(store, args);
  if (repo === null) return { ok: false, error: `Repository not found: ${argString(args, 'owner')}/${argString(args, 'repo')}` };
  const pull = repo.pulls.find((entry) => entry.number === pullNumber);
  if (pull === undefined) return { ok: false, error: `Pull request #${pullNumber} not found` };
  const result = repo.squashMerge(pull);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: pullJson(repo, pull) };
}

const TOOL_HANDLERS: Readonly<Record<string, (store: ForgeStore, args: Record<string, unknown>) => ToolOutcome>> = {
  create_repo: toolCreateRepo,
  get_repo: toolGetRepo,
  create_issue: toolCreateIssue,
  list_issues: toolListIssues,
  create_pull_request: toolCreatePullRequest,
  merge_pull_request: toolMergePullRequest,
};

// ---------------------------------------------------------------- JSON-RPC

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function discoverResult(): Record<string, unknown> {
  const info = serverInfo();
  return {
    resultType: 'discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: CAPABILITIES,
    serverInfo: info,
    instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests over MCP tools.',
    _meta: { 'io.modelcontextprotocol/serverInfo': info },
  };
}

function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
  return { protocolVersion: negotiated, capabilities: CAPABILITIES, serverInfo: serverInfo() };
}

/** One tools/call: a result envelope, or a JSON-RPC error for an unknown tool. */
function handleToolsCall(store: ForgeStore, id: JsonRpcId, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  if (name === '') return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
  const handler = TOOL_HANDLERS[name];
  if (handler === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const outcome = handler(store, args);
  if (!outcome.ok) {
    return rpcResult(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
  }
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
    structuredContent: outcome.data,
  });
}

/**
 * Dispatch one JSON-RPC request object. Returns undefined for a notification
 * (no id, or a `notifications/*` method), which the caller answers with
 * HTTP 202 and no body.
 */
function dispatchRequest(request: unknown, store: ForgeStore): Record<string, unknown> | undefined {
  if (!isRecord(request)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const hasId = 'id' in request && request.id !== undefined;
  const id = (hasId ? request.id : null) as JsonRpcId;
  if (method === '') {
    if (!hasId) return undefined;
    return rpcError(id, -32600, 'Invalid Request: missing method');
  }
  if (method.startsWith('notifications/')) return undefined;
  if (!hasId) return undefined;
  const params = isRecord(request.params) ? request.params : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize':
      return rpcResult(id, initializeResult(params));
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return handleToolsCall(store, id, params);
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(ctx: RequestContext, store: ForgeStore): boolean {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }
  if (ctx.bodyMalformed) {
    sendJson(ctx, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: body is not valid JSON' },
    });
    return true;
  }
  const body = ctx.body;
  if (Array.isArray(body)) {
    // A JSON-RPC batch: one response per request, in order; notifications
    // get no response.
    const responses: unknown[] = [];
    for (const item of body) {
      const response = dispatchRequest(item, store);
      if (response !== undefined) responses.push(response);
    }
    sendJson(ctx, 200, responses);
    return true;
  }
  if (body === undefined) {
    sendJson(ctx, 200, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: empty body' },
    });
    return true;
  }
  const response = dispatchRequest(body, store);
  if (response === undefined) {
    // A notification: HTTP 202, no body.
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId, 'content-length': 0 });
    ctx.res.end();
    return true;
  }
  sendJson(ctx, 200, response);
  return true;
}
