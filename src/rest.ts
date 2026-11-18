// The REST v3 surface: /api/v3. Every route the conformance suite drives,
// with the exact statuses and shapes checks-rest.ts requires:
//
//   GET    /api/v3/                 200 JSON + X-OAuth-Scopes
//   GET    /api/v3/meta             200 {installed_version}
//   GET    /api/v3/user             200 {login, ...}  (the token's own login)
//   GET    /api/v3/user/repos       200 list, Link rel="next" when paged
//   POST   /api/v3/user/repos       201, 422 when the name is taken
//   GET    /api/v3/repos/{o}/{r}    200, 404 when absent or foreign
//   PATCH  /api/v3/repos/{o}/{r}    200, description updated
//   DELETE /api/v3/repos/{o}/{r}    204, gone afterwards
//   POST   /api/v3/repos/{o}/{r}/git/refs   201 {ref, object:{sha}}
//   GET    .../git/refs[/heads/{b}]          ref list / one ref
//   GET    .../branches[/{b}]       [{name, commit:{sha}}]
//   GET    .../commits[?sha=<ref>]  [{sha, commit:{message}}]
//   PUT    .../contents/{path}      201 create, 200 update, 409 stale sha
//   GET    .../contents/{path}[?ref=]        file (base64) or directory list
//   DELETE .../contents/{path}      200 {commit:{sha}}
//   POST   .../labels               201 {name, color}
//   POST   .../issues               201 open issue, 422 unknown label
//   GET    .../issues[?state=&sort=&direction=]
//   GET    .../issues/{n}  PATCH .../issues/{n}  (close)
//   POST/GET .../issues/{n}/comments
//   POST   .../pulls                201 open pull, head/base refs
//   GET    .../pulls[?state=]  GET .../pulls/{n}  GET .../pulls/{n}/files
//   PUT    .../pulls/{n}/merge      200 {sha, merged:true, message}, 404/405
//
// Ownership: a repository belongs to the viewer (the login the token names),
// so the same name under another owner is 404, never 403.

import { blobSha, type CommitObj } from './gitobj.ts';
import type { RequestContext } from './http.ts';
import {
  bodyBoolean,
  bodyObject,
  bodyString,
  queryInt,
  requireAuth,
  sendError,
  sendJson,
  sendNoContent,
} from './http.ts';
import { type ForgeStore, type Issue, type Label, type Pull, type Repo } from './store.ts';
import { b64decode, b64encode, isSha40, nodeId, splitPath, trialNowIso } from './util.ts';
import { viewerUser } from './viewer.ts';

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

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('I', `${repo.full_name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
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

function commitJson(repo: Repo, commit: CommitObj): Record<string, unknown> {
  const date = new Date(commit.timestamp * 1000).toISOString();
  return {
    sha: commit.sha,
    node_id: nodeId('C', `${repo.full_name}@${commit.sha}`),
    commit: {
      message: commit.message,
      author: { name: commit.authorName, email: commit.authorEmail, date },
      committer: { name: commit.committerName, email: commit.committerEmail, date },
      tree: { sha: commit.tree },
    },
    author: { login: commit.authorName, id: 1000, type: 'User' },
    committer: { login: commit.committerName, id: 1000, type: 'User' },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

/** Resolve /repos/{owner}/{name}; 404 when foreign or missing. */
function resolveRepo(ctx: RequestContext, store: ForgeStore, owner: string, name: string): Repo | null {
  if (owner !== store.viewer) return null;
  return store.getRepo(owner, name);
}

function notFound(ctx: RequestContext, what: string): void {
  sendError(ctx, 404, `${what} not found`);
}

/** Build a Link header value for a paged list (absolute, from the Host). */
function linkHeader(ctx: RequestContext, page: number, perPage: number, totalPages: number): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${ctx.path}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  return links.join(', ');
}

/**
 * Handle a /api/v3 request. Returns true when the route was handled (even
 * as an error); false when the path is not under /api/v3 at all.
 */
export function handleRest(ctx: RequestContext, store: ForgeStore): boolean {
  const { method, path } = ctx;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;

  // Every /api/v3 route needs the bearer token.
  if (!requireAuth(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }
  if (ctx.bodyMalformed) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }

  const segments = splitPath(path);

  // GET /api/v3/ — the API root.
  if (method === 'GET' && segments.length === 2) {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 3 && segments[2] === 'meta') {
    sendJson(ctx, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user — the token's own login.
  if (method === 'GET' && segments.length === 3 && segments[2] === 'user') {
    const user = viewerUser();
    sendJson(ctx, 200, { ...user, html_url: `https://example.invalid/${user.login}`, url: '/api/v3/user' });
    return true;
  }

  // /api/v3/user/repos — list (paged) and create.
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.min(100, Math.max(1, queryInt(ctx, 'per_page', 30)));
      const page = queryInt(ctx, 'page', 1);
      const all = store.viewerRepos();
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx, page, perPage, totalPages);
      if (link !== '') headers.link = link;
      sendJson(ctx, 200, slice.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const name = bodyString(body.name).trim();
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return true;
      }
      const created = store.createRepo(
        name,
        bodyBoolean(body.private, false),
        bodyString(body.description),
        bodyString(body.default_branch, 'main') || 'main',
      );
      if (created === null) {
        sendError(ctx, 422, 'name already exists on this account');
        return true;
      }
      sendJson(ctx, 201, repoJson(created));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3] as string);
    const name = decodeURIComponent(segments[4] as string);
    const repo = resolveRepo(ctx, store, owner, name);
    if (repo === null) {
      notFound(ctx, 'Repository');
      return true;
    }
    const rest = segments.slice(5);
    return handleRepoRoutes(ctx, store, repo, rest);
  }

  // Anything else under /api/v3: JSON 404.
  notFound(ctx, 'Route');
  return true;
}

function handleRepoRoutes(ctx: RequestContext, store: ForgeStore, repo: Repo, rest: string[]): boolean {
  const { method } = ctx;

  // /repos/{o}/{r} itself: GET, PATCH, DELETE.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateFlag = body.private;
      repo.updated_at = trialNowIso();
      sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendNoContent(ctx);
      return true;
    }
    return false;
  }

  const head = rest[0] as string;

  // --- git refs -----------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = bodyObject(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const ref = bodyString(body.ref);
      const sha = bodyString(body.sha);
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
        sendError(ctx, 422, 'ref must start with refs/heads/ or refs/tags/');
        return true;
      }
      if (!isSha40(sha) || !repo.commits.has(sha)) {
        sendError(ctx, 422, 'sha does not name a commit in this repository');
        return true;
      }
      const isBranch = ref.startsWith('refs/heads/');
      const short = ref.slice(isBranch ? 'refs/heads/'.length : 'refs/tags/'.length);
      const existing = isBranch ? repo.branches.get(short) : repo.tags.get(short);
      if (existing !== undefined) {
        sendError(ctx, 422, 'ref already exists');
        return true;
      }
      if (isBranch) repo.branches.set(short, sha);
      else repo.tags.set(short, sha);
      sendJson(ctx, 201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
      return true;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const refs: Record<string, unknown>[] = [];
        for (const [branch, sha] of [...repo.branches.entries()].sort()) {
          refs.push({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
        }
        for (const [tag, sha] of [...repo.tags.entries()].sort()) {
          refs.push({ ref: `refs/tags/${tag}`, object: { sha, type: 'commit' } });
        }
        sendJson(ctx, 200, refs);
        return true;
      }
      if (rest.length === 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest[3] as string);
        const sha = repo.branches.get(branch);
        if (sha === undefined) {
          notFound(ctx, 'Reference');
          return true;
        }
        sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
        return true;
      }
      if (rest.length === 4 && rest[2] === 'tags') {
        const tag = decodeURIComponent(rest[3] as string);
        const sha = repo.tags.get(tag);
        if (sha === undefined) {
          notFound(ctx, 'Reference');
          return true;
        }
        sendJson(ctx, 200, { ref: `refs/tags/${tag}`, object: { sha, type: 'commit' } });
        return true;
      }
    }
    return false;
  }

  // --- branches -----------------------------------------------------------
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.branches.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([branch, sha]) => ({ name: branch, commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false }));
      sendJson(ctx, 200, list);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1] as string);
      const sha = repo.branches.get(branch);
      if (sha === undefined) {
        notFound(ctx, 'Branch');
        return true;
      }
      sendJson(ctx, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false });
      return true;
    }
    return false;
  }

  // --- commits ------------------------------------------------------------
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = ctx.query.get('sha');
      const tip = ref !== null ? repo.resolveRef(ref) : repo.defaultTip();
      if (tip === null) {
        sendJson(ctx, 200, []);
        return true;
      }
      const list = repo.ancestors(tip).map((sha) => {
        const commit = repo.commits.get(sha) as CommitObj;
        return commitJson(repo, commit);
      });
      sendJson(ctx, 200, list);
      return true;
    }
    return false;
  }

  // --- contents -----------------------------------------------------------
  if (head === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'PUT') return putContent(ctx, repo, filePath);
    if (method === 'GET') return getContent(ctx, repo, filePath);
    if (method === 'DELETE') return deleteContent(ctx, repo, filePath);
    return false;
  }

  // --- labels -------------------------------------------------------------
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = bodyObject(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const name = bodyString(body.name).trim();
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        sendError(ctx, 422, 'label already exists');
        return true;
      }
      const label: Label = {
        name,
        color: bodyString(body.color, 'ededed').replace(/^#/, ''),
        description: bodyString(body.description),
      };
      repo.labels.set(name, label);
      sendJson(ctx, 201, labelJson(label));
      return true;
    }
    return false;
  }

  // --- issues -------------------------------------------------------------
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(ctx, repo);
      if (method === 'GET') return listIssues(ctx, repo);
      return false;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isSafeInteger(number) || number < 1) {
      notFound(ctx, 'Issue');
      return true;
    }
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) {
      notFound(ctx, 'Issue');
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJson(ctx, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') return patchIssue(ctx, repo, issue);
      return false;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        sendJson(ctx, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: c.user, created_at: c.created_at, updated_at: c.updated_at })));
        return true;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        if (body === null) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const text = bodyString(body.body);
        if (text === '') {
          sendError(ctx, 422, 'body is required');
          return true;
        }
        const comment = repo.addComment(issue, text);
        sendJson(ctx, 201, { id: comment.id, body: comment.body, user: comment.user, created_at: comment.created_at, updated_at: comment.updated_at });
        return true;
      }
      return false;
    }
    return false;
  }

  // --- pull requests ------------------------------------------------------
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(ctx, repo);
      if (method === 'GET') return listPulls(ctx, repo);
      return false;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isSafeInteger(number) || number < 1) {
      notFound(ctx, 'Pull request');
      return true;
    }
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) {
      notFound(ctx, 'Pull request');
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJson(ctx, 200, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      sendJson(ctx, 200, pull.files.map((f) => ({ ...f, patch: undefined })));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      return mergePull(ctx, repo, pull);
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------- contents

function putContent(ctx: RequestContext, repo: Repo, filePath: string): boolean {
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  if (filePath === '') {
    sendError(ctx, 422, 'path is required');
    return true;
  }
  const contentB64 = bodyString(body.content);
  const content = b64decode(contentB64);
  if (content === null) {
    sendError(ctx, 422, 'content must be base64');
    return true;
  }
  const message = bodyString(body.message, `Update ${filePath}`);
  const branch = bodyString(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const tip = repo.branches.get(branch);
  const baseTree = tip === undefined ? '' : (repo.commits.get(tip)?.tree ?? '');
  const current = tip === undefined ? null : repo.lookupPath(baseTree, filePath);
  const providedSha = bodyString(body.sha);
  if (current !== null && current.kind === 'file') {
    if (providedSha !== '' && providedSha !== current.entry.sha) {
      sendError(ctx, 409, 'sha does not match the current file');
      return true;
    }
  } else if (providedSha !== '') {
    sendError(ctx, 409, 'sha does not match the current file');
    return true;
  }
  const isUpdate = current !== null && current.kind === 'file';
  const nextTree = repo.writePath(baseTree, filePath, content);
  const commit = repo.commitOnBranch(branch, nextTree, tip === undefined ? [] : [tip], message);
  const blob = blobSha(content);
  sendJson(ctx, isUpdate ? 200 : 201, {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blob,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: b64encode(content),
    },
    commit: { sha: commit.sha, message: commit.message },
  });
  return true;
}

function getContent(ctx: RequestContext, repo: Repo, filePath: string): boolean {
  const ref = ctx.query.get('ref');
  const tip = ref !== null ? repo.resolveRef(ref) : repo.defaultTip();
  if (tip === null) {
    notFound(ctx, 'Content');
    return true;
  }
  const commit = repo.commits.get(tip);
  if (commit === undefined) {
    notFound(ctx, 'Content');
    return true;
  }
  const found = repo.lookupPath(commit.tree, filePath);
  if (found === null) {
    notFound(ctx, 'Content');
    return true;
  }
  if (found.kind === 'file') {
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: found.content.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      content: b64encode(found.content),
      sha: found.entry.sha,
    });
    return true;
  }
  const list = found.entries
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({
      type: entry.type === 'tree' ? 'dir' : 'file',
      name: entry.name,
      path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
      sha: entry.sha,
      size: entry.type === 'blob' ? (repo.blobs.get(entry.sha)?.length ?? 0) : 0,
    }));
  sendJson(ctx, 200, list);
  return true;
}

function deleteContent(ctx: RequestContext, repo: Repo, filePath: string): boolean {
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const branch = bodyString(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const tip = repo.branches.get(branch);
  if (tip === undefined) {
    notFound(ctx, 'Content');
    return true;
  }
  const commit = repo.commits.get(tip);
  if (commit === undefined) {
    notFound(ctx, 'Content');
    return true;
  }
  const current = repo.lookupPath(commit.tree, filePath);
  if (current === null || current.kind !== 'file') {
    notFound(ctx, 'Content');
    return true;
  }
  const providedSha = bodyString(body.sha);
  if (providedSha !== '' && providedSha !== current.entry.sha) {
    sendError(ctx, 409, 'sha does not match the current file');
    return true;
  }
  const nextTree = repo.removePath(commit.tree, filePath);
  if (nextTree === null) {
    notFound(ctx, 'Content');
    return true;
  }
  const message = bodyString(body.message, `Delete ${filePath}`);
  const next = repo.commitOnBranch(branch, nextTree, [tip], message);
  sendJson(ctx, 200, { commit: { sha: next.sha, message: next.message } });
  return true;
}

// ---------------------------------------------------------------- issues

function createIssue(ctx: RequestContext, repo: Repo): boolean {
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const title = bodyString(body.title).trim();
  if (title === '') {
    sendError(ctx, 422, 'title is required');
    return true;
  }
  const labelNames = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) {
      sendError(ctx, 422, `label '${name}' does not exist`);
      return true;
    }
    labels.push(label);
  }
  const issue = repo.createIssue(title, bodyString(body.body), labels);
  sendJson(ctx, 201, issueJson(repo, issue));
  return true;
}

function listIssues(ctx: RequestContext, repo: Repo): boolean {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = repo.issues.slice();
  if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
  if (sort === 'created' || sort === 'updated') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  sendJson(ctx, 200, list.map((i) => issueJson(repo, i)));
  return true;
}

function patchIssue(ctx: RequestContext, repo: Repo, issue: Issue): boolean {
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
    issue.state = body.state;
  }
  if (Array.isArray(body.labels)) {
    const labelNames = body.labels.filter((l): l is string => typeof l === 'string');
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) {
        sendError(ctx, 422, `label '${name}' does not exist`);
        return true;
      }
      labels.push(label);
    }
    issue.labels = labels;
  }
  issue.updated_at = trialNowIso();
  sendJson(ctx, 200, issueJson(repo, issue));
  return true;
}

// ---------------------------------------------------------------- pulls

function createPull(ctx: RequestContext, repo: Repo): boolean {
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const title = bodyString(body.title).trim();
  if (title === '') {
    sendError(ctx, 422, 'title is required');
    return true;
  }
  const headRef = bodyString(body.head).trim();
  const baseRef = bodyString(body.base).trim();
  if (headRef === '' || baseRef === '') {
    sendError(ctx, 422, 'head and base are required');
    return true;
  }
  const created = repo.createPull(headRef, baseRef, title, bodyString(body.body));
  if (!created.ok) {
    sendError(ctx, 422, created.error);
    return true;
  }
  sendJson(ctx, 201, pullJson(repo, created.pull));
  return true;
}

function listPulls(ctx: RequestContext, repo: Repo): boolean {
  const state = ctx.query.get('state') ?? 'open';
  let list = repo.pulls.slice();
  if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
  list.sort((a, b) => b.number - a.number);
  sendJson(ctx, 200, list.map((p) => pullJson(repo, p)));
  return true;
}

function mergePull(ctx: RequestContext, repo: Repo, pull: Pull): boolean {
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const merged = repo.squashMerge(pull, {
    method: bodyString(body.merge_method, 'squash'),
    commitTitle: bodyString(body.commit_title, pull.title),
    commitMessage: bodyString(body.commit_message, ''),
  });
  if (!merged.ok) {
    sendError(ctx, 405, merged.error);
    return true;
  }
  sendJson(ctx, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged.' });
  return true;
}
