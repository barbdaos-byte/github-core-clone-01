// GraphQL v4 executor (Phase 3): a real parser, validator and resolver
// over the shared ForgeStore — the same store REST and git use, so a
// mutation made here is visible on the other surfaces by construction.
//
// POST /api/graphql takes {"query", "variables", "operationName"} with the
// trial's bearer token; unauthenticated is exactly 401, a body that is not
// JSON is 400, and a batched request (a JSON array of operations) answers
// one result per operation, in order, with HTTP 200. A GraphQL-level
// failure — an unknown field, a bad argument, a mutation that cannot apply
// — is HTTP 200 with an `errors` array, never an HTTP error. A repository
// lookup for an unknown owner/name is data.repository = null with no errors.

import type { RequestContext } from './http.ts';
import { bodyObject, requireAuth, sendError, sendJson } from './http.ts';
import {
  GraphQLSyntaxError,
  parseDocument,
  resolveArguments,
  type DocumentNode,
  type FragmentNode,
  type OperationNode,
  type SelectionNode,
  type ValueNode,
} from './gql.ts';
import type { Comment, ForgeStore, Issue, Pull, Repo } from './store.ts';
import { b64decode, b64encode, nodeId, trialNowIso } from './util.ts';

// ---------------------------------------------------------------------------
// Runtime values
// ---------------------------------------------------------------------------

/** A resolved object value: its GraphQL type and the store object behind it. */
interface GqlObject {
  __typename: string;
  value: unknown;
}

type GqlValue = GqlObject | GqlObject[] | string | number | boolean | null;

function obj(typename: string, value: unknown): GqlObject {
  return { __typename: typename, value };
}

function isGqlObject(value: unknown): value is GqlObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && '__typename' in (value as Record<string, unknown>);
}

interface GqlContext {
  store: ForgeStore;
}

class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

// ---------------------------------------------------------------------------
// Global ids (the same opaque ids REST exposes as node_id)
// ---------------------------------------------------------------------------

function repoGlobalId(repo: Repo): string {
  return nodeId('R', repo.full_name);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return nodeId('I', `${repo.full_name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return nodeId('PR', `${repo.full_name}#${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return nodeId('IC', `${repo.full_name}#${issue.number}:${comment.id}`);
}

function userGlobalId(login: string): string {
  return nodeId('U', login);
}

function findRepoById(store: ForgeStore, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  for (const repo of store.viewerRepos()) {
    if (repoGlobalId(repo) === id) return repo;
  }
  return null;
}

function findIssueById(store: ForgeStore, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  for (const repo of store.viewerRepos()) {
    for (const issue of repo.issues) {
      if (issueGlobalId(repo, issue) === id) return { repo, issue };
    }
  }
  return null;
}

function findPullById(store: ForgeStore, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  for (const repo of store.viewerRepos()) {
    for (const pull of repo.pulls) {
      if (pullGlobalId(repo, pull) === id) return { repo, pull };
    }
  }
  return null;
}

function findNode(store: ForgeStore, id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const repo = findRepoById(store, id);
  if (repo !== null) return obj('Repository', repo);
  const issue = findIssueById(store, id);
  if (issue !== null) return obj('Issue', issue);
  const pull = findPullById(store, id);
  if (pull !== null) return obj('PullRequest', pull);
  for (const r of store.viewerRepos()) {
    for (const i of r.issues) {
      for (const comment of i.comments) {
        if (commentGlobalId(r, i, comment) === id) return obj('IssueComment', { repo: r, issue: i, comment });
      }
    }
  }
  if (userGlobalId(store.viewer) === id) return obj('User', { login: store.viewer });
  return null;
}

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function encodeCursor(raw: string): string {
  return b64encode(Buffer.from(`cursor:${raw}`, 'utf8'));
}

function decodeCursor(after: unknown): string | null {
  if (typeof after !== 'string' || after === '') return null;
  const decoded = b64decode(after);
  if (decoded === null) return null;
  const text = decoded.toString('utf8');
  return text.startsWith('cursor:') ? text.slice('cursor:'.length) : null;
}

function paginate<T>(
  items: readonly T[],
  first: unknown,
  after: unknown,
  cursorFor: (item: T, index: number) => string,
): { page: T[]; pageInfo: PageInfo; cursors: string[] } {
  let start = 0;
  const afterRaw = decodeCursor(after);
  if (afterRaw !== null) {
    const index = items.findIndex((item, i) => cursorFor(item, i) === afterRaw);
    if (index >= 0) start = index + 1;
  }
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const page = items.slice(start, start + limit);
  const cursors = page.map((item, i) => encodeCursor(cursorFor(item, start + i)));
  return {
    page: [...page],
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: cursors.length > 0 ? (cursors[0] as string) : null,
      endCursor: cursors.length > 0 ? (cursors[cursors.length - 1] as string) : null,
    },
    cursors,
  };
}

function issueConnectionValue(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: unknown; direction?: unknown } | null;
  if (orderBy !== null && typeof orderBy === 'object') {
    const field = String(orderBy.field ?? 'CREATED_AT');
    const direction = String(orderBy.direction ?? 'ASC');
    const key = (issue: Issue): [string, number] =>
      field === 'UPDATED_AT' ? [issue.updated_at, issue.seq] : [issue.created_at, issue.seq];
    list.sort((a, b) => {
      const [ka, sa] = key(a);
      const [kb, sb] = key(b);
      const cmp = ka < kb ? -1 : ka > kb ? 1 : sa - sb;
      return direction === 'DESC' ? -cmp : cmp;
    });
  } else {
    list.sort((a, b) => a.seq - b.seq);
  }
  const { page, pageInfo, cursors } = paginate(list, args.first, args.after, (issue) => `issue:${issue.seq}`);
  const nodes = page.map((issue) => obj('Issue', { repo, issue }));
  return obj('IssueConnection', { nodes, cursors, pageInfo, totalCount: list.length });
}

function pullRequestConnectionValue(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = repo.pulls.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const { page, pageInfo, cursors } = paginate(list, args.first, args.after, (pull) => `pr:${pull.number}`);
  const nodes = page.map((pull) => obj('PullRequest', { repo, pull }));
  return obj('PullRequestConnection', { nodes, cursors, pageInfo, totalCount: list.length });
}

function fileConnectionValue(pull: Pull, args: Record<string, unknown>): GqlObject {
  const { page, pageInfo, cursors } = paginate(pull.files, args.first, args.after, (_file, index) => `file:${index}`);
  const nodes = page.map((file) => obj('PullRequestFile', { path: file.filename }));
  return obj('PullRequestFileConnection', { nodes, cursors, pageInfo, totalCount: pull.files.length });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface ArgDef {
  type: string;
  required?: boolean;
}

interface FieldDef {
  args?: Record<string, ArgDef>;
  /** Declared return type: a scalar, an object type, or a list like "[Issue]". */
  type: string;
  resolve: (parent: unknown, args: Record<string, unknown>, ctx: GqlContext) => unknown;
}

interface TypeDef {
  kind: 'object' | 'interface' | 'enum' | 'scalar';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  possibleTypes?: string[];
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function userObj(login: string): GqlObject {
  return obj('User', { login });
}

function repoObj(repo: Repo): GqlObject {
  return obj('Repository', repo);
}

function issueObj(repo: Repo, issue: Issue): GqlObject {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: Repo, pull: Pull): GqlObject {
  return obj('PullRequest', { repo, pull });
}

function commentObj(repo: Repo, issue: Issue, comment: Comment): GqlObject {
  return obj('IssueComment', { repo, issue, comment });
}

function connectionFields(itemType: string): Record<string, FieldDef> {
  return {
    nodes: {
      type: `[${itemType}]`,
      resolve: (parent) => (parent as { nodes: GqlObject[] }).nodes,
    },
    edges: {
      type: `[${itemType}Edge]`,
      resolve: (parent) => {
        const value = parent as { nodes: GqlObject[]; cursors: string[] };
        return value.nodes.map((node, index) =>
          obj(`${itemType}Edge`, { node, cursor: value.cursors[index] ?? null }),
        );
      },
    },
    pageInfo: {
      type: 'PageInfo',
      resolve: (parent) => obj('PageInfo', (parent as { pageInfo: PageInfo }).pageInfo),
    },
    totalCount: {
      type: 'Int',
      resolve: (parent) => (parent as { totalCount: number }).totalCount,
    },
  };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'object',
    fields: {
      viewer: {
        type: 'User',
        resolve: (_parent, _args, ctx) => userObj(ctx.store.viewer),
      },
      repository: {
        args: { owner: { type: 'String', required: true }, name: { type: 'String', required: true } },
        type: 'Repository',
        resolve: (_parent, args, ctx) => {
          if (args.owner !== ctx.store.viewer) return null;
          const repo = ctx.store.getRepo(String(args.owner), String(args.name));
          return repo === null ? null : repoObj(repo);
        },
      },
      node: {
        args: { id: { type: 'ID', required: true } },
        type: 'Node',
        resolve: (_parent, args, ctx) => findNode(ctx.store, args.id),
      },
      __type: {
        args: { name: { type: 'String', required: true } },
        type: '__Type',
        resolve: (_parent, args) => {
          const name = String(args.name);
          const def = SCHEMA[name];
          if (def === undefined) return null;
          return obj('__Type', {
            name,
            kind: def.kind === 'object' ? 'OBJECT' : def.kind === 'interface' ? 'INTERFACE' : def.kind === 'enum' ? 'ENUM' : 'SCALAR',
            fields: def.fields === undefined ? [] : Object.keys(def.fields),
            enumValues: def.enumValues ?? [],
          });
        },
      },
    },
  },
  Mutation: {
    kind: 'object',
    fields: {
      createIssue: {
        args: { input: { type: 'CreateIssueInput', required: true } },
        type: 'CreateIssuePayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = findRepoById(ctx.store, input.repositoryId);
          if (repo === null) throw new GqlError(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
          const title = typeof input.title === 'string' ? input.title.trim() : '';
          if (title === '') throw new GqlError('Title is required for an issue.');
          const issue = repo.createIssue(title, typeof input.body === 'string' ? input.body : '');
          return obj('CreateIssuePayload', { issue: issueObj(repo, issue) });
        },
      },
      closeIssue: {
        args: { input: { type: 'CloseIssueInput', required: true } },
        type: 'CloseIssuePayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueById(ctx.store, input.issueId);
          if (found === null) throw new GqlError(`Could not resolve to an Issue with the id of '${String(input.issueId)}'.`);
          found.issue.state = 'closed';
          found.issue.updated_at = trialNowIso();
          return obj('CloseIssuePayload', { issue: issueObj(found.repo, found.issue) });
        },
      },
      createPullRequest: {
        args: { input: { type: 'CreatePullRequestInput', required: true } },
        type: 'CreatePullRequestPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = findRepoById(ctx.store, input.repositoryId);
          if (repo === null) throw new GqlError(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
          const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
          const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
          const title = typeof input.title === 'string' ? input.title.trim() : '';
          if (title === '') throw new GqlError('Title is required for a pull request.');
          const created = repo.createPull(headRef, baseRef, title, typeof input.body === 'string' ? input.body : '');
          if (!created.ok) throw new GqlError(created.error);
          return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, created.pull) });
        },
      },
      mergePullRequest: {
        args: { input: { type: 'MergePullRequestInput', required: true } },
        type: 'MergePullRequestPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findPullById(ctx.store, input.pullRequestId);
          if (found === null) throw new GqlError(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.`);
          const merged = found.repo.squashMerge(found.pull, {
            method: typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH',
          });
          if (!merged.ok) throw new GqlError(merged.error);
          return obj('MergePullRequestPayload', { pullRequest: pullObj(found.repo, found.pull) });
        },
      },
      addComment: {
        args: { input: { type: 'AddCommentInput', required: true } },
        type: 'AddCommentPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueById(ctx.store, input.subjectId);
          if (found === null) throw new GqlError(`Could not resolve to an Issue with the id of '${String(input.subjectId)}'.`);
          const body = typeof input.body === 'string' ? input.body : '';
          if (body === '') throw new GqlError('Body is required for a comment.');
          const comment = found.repo.addComment(found.issue, body);
          return obj('AddCommentPayload', {
            commentEdge: obj('IssueCommentEdge', { node: commentObj(found.repo, found.issue, comment) }),
          });
        },
      },
    },
  },
  Node: {
    kind: 'interface',
    possibleTypes: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'],
    fields: {
      id: { type: 'ID', resolve: () => null },
    },
  },
  User: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (parent) => userGlobalId((parent as { login: string }).login) },
      login: { type: 'String', resolve: (parent) => (parent as { login: string }).login },
      name: { type: 'String', resolve: (parent) => (parent as { login: string }).login },
    },
  },
  Repository: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (parent) => repoGlobalId(parent as Repo) },
      databaseId: { type: 'Int', resolve: (parent) => (parent as Repo).id },
      name: { type: 'String', resolve: (parent) => (parent as Repo).name },
      nameWithOwner: { type: 'String', resolve: (parent) => (parent as Repo).full_name },
      owner: { type: 'User', resolve: (parent) => userObj((parent as Repo).owner) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (parent) => {
          const repo = parent as Repo;
          return repo.branches.has(repo.defaultBranch) ? obj('Ref', { name: repo.defaultBranch }) : null;
        },
      },
      viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      description: { type: 'String', resolve: (parent) => (parent as Repo).description },
      issue: {
        args: { number: { type: 'Int', required: true } },
        type: 'Issue',
        resolve: (parent, args) => {
          const repo = parent as Repo;
          const issue = repo.issues.find((i) => i.number === args.number);
          return issue === undefined ? null : issueObj(repo, issue);
        },
      },
      issues: {
        args: {
          first: { type: 'Int' },
          after: { type: 'String' },
          states: { type: '[IssueState]' },
          orderBy: { type: 'IssueOrder' },
        },
        type: 'IssueConnection',
        resolve: (parent, args) => issueConnectionValue(parent as Repo, args),
      },
      pullRequests: {
        args: { first: { type: 'Int' }, after: { type: 'String' }, states: { type: '[PullRequestState]' } },
        type: 'PullRequestConnection',
        resolve: (parent, args) => pullRequestConnectionValue(parent as Repo, args),
      },
      pullRequest: {
        args: { number: { type: 'Int', required: true } },
        type: 'PullRequest',
        resolve: (parent, args) => {
          const repo = parent as Repo;
          const pull = repo.pulls.find((p) => p.number === args.number);
          return pull === undefined ? null : pullObj(repo, pull);
        },
      },
    },
  },
  Ref: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
    },
  },
  Issue: {
    kind: 'object',
    fields: {
      id: {
        type: 'ID',
        resolve: (parent) => {
          const { repo, issue } = parent as { repo: Repo; issue: Issue };
          return issueGlobalId(repo, issue);
        },
      },
      number: { type: 'Int', resolve: (parent) => (parent as { issue: Issue }).issue.number },
      title: { type: 'String', resolve: (parent) => (parent as { issue: Issue }).issue.title },
      body: { type: 'String', resolve: (parent) => (parent as { issue: Issue }).issue.body },
      state: {
        type: 'IssueState',
        resolve: (parent) => ((parent as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
      },
      createdAt: { type: 'String', resolve: (parent) => (parent as { issue: Issue }).issue.created_at },
      updatedAt: { type: 'String', resolve: (parent) => (parent as { issue: Issue }).issue.updated_at },
      author: {
        type: 'User',
        resolve: (parent) => userObj((parent as { issue: Issue }).issue.user.login),
      },
      repository: {
        type: 'Repository',
        resolve: (parent) => repoObj((parent as { repo: Repo }).repo),
      },
    },
  },
  IssueConnection: { kind: 'object', fields: connectionFields('Issue') },
  IssueEdge: {
    kind: 'object',
    fields: {
      node: { type: 'Issue', resolve: (parent) => (parent as { node: GqlObject }).node },
      cursor: { type: 'String', resolve: (parent) => (parent as { cursor: string | null }).cursor },
    },
  },
  PullRequest: {
    kind: 'object',
    fields: {
      id: {
        type: 'ID',
        resolve: (parent) => {
          const { repo, pull } = parent as { repo: Repo; pull: Pull };
          return pullGlobalId(repo, pull);
        },
      },
      number: { type: 'Int', resolve: (parent) => (parent as { pull: Pull }).pull.number },
      title: { type: 'String', resolve: (parent) => (parent as { pull: Pull }).pull.title },
      body: { type: 'String', resolve: (parent) => (parent as { pull: Pull }).pull.body },
      state: {
        type: 'PullRequestState',
        resolve: (parent) => {
          const pull = (parent as { pull: Pull }).pull;
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        },
      },
      merged: { type: 'Boolean', resolve: (parent) => (parent as { pull: Pull }).pull.merged },
      mergeable: {
        type: 'MergeableState',
        resolve: (parent) => ((parent as { pull: Pull }).pull.mergeable ? 'MERGEABLE' : 'CONFLICTING'),
      },
      headRefName: { type: 'String', resolve: (parent) => (parent as { pull: Pull }).pull.head.ref },
      baseRefName: { type: 'String', resolve: (parent) => (parent as { pull: Pull }).pull.base.ref },
      files: {
        args: { first: { type: 'Int' }, after: { type: 'String' } },
        type: 'PullRequestFileConnection',
        resolve: (parent, args) => fileConnectionValue((parent as { pull: Pull }).pull, args),
      },
      createdAt: { type: 'String', resolve: (parent) => (parent as { pull: Pull }).pull.created_at },
      updatedAt: { type: 'String', resolve: (parent) => (parent as { pull: Pull }).pull.updated_at },
      author: {
        type: 'User',
        resolve: (parent) => userObj((parent as { pull: Pull }).pull.user.login),
      },
      repository: {
        type: 'Repository',
        resolve: (parent) => repoObj((parent as { repo: Repo }).repo),
      },
    },
  },
  PullRequestConnection: { kind: 'object', fields: connectionFields('PullRequest') },
  PullRequestEdge: {
    kind: 'object',
    fields: {
      node: { type: 'PullRequest', resolve: (parent) => (parent as { node: GqlObject }).node },
      cursor: { type: 'String', resolve: (parent) => (parent as { cursor: string | null }).cursor },
    },
  },
  PullRequestFile: {
    kind: 'object',
    fields: {
      path: { type: 'String', resolve: (parent) => (parent as { path: string }).path },
    },
  },
  PullRequestFileConnection: { kind: 'object', fields: connectionFields('PullRequestFile') },
  PullRequestFileEdge: {
    kind: 'object',
    fields: {
      node: { type: 'PullRequestFile', resolve: (parent) => (parent as { node: GqlObject }).node },
      cursor: { type: 'String', resolve: (parent) => (parent as { cursor: string | null }).cursor },
    },
  },
  IssueComment: {
    kind: 'object',
    fields: {
      id: {
        type: 'ID',
        resolve: (parent) => {
          const { repo, issue, comment } = parent as { repo: Repo; issue: Issue; comment: Comment };
          return commentGlobalId(repo, issue, comment);
        },
      },
      body: { type: 'String', resolve: (parent) => (parent as { comment: Comment }).comment.body },
      author: {
        type: 'User',
        resolve: (parent) => userObj((parent as { comment: Comment }).comment.user.login),
      },
    },
  },
  IssueCommentEdge: {
    kind: 'object',
    fields: {
      node: { type: 'IssueComment', resolve: (parent) => (parent as { node: GqlObject }).node },
      cursor: { type: 'String', resolve: (parent) => (parent as { cursor: string | null }).cursor },
    },
  },
  PageInfo: {
    kind: 'object',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (parent) => (parent as PageInfo).hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (parent) => (parent as PageInfo).hasPreviousPage },
      startCursor: { type: 'String', resolve: (parent) => (parent as PageInfo).startCursor },
      endCursor: { type: 'String', resolve: (parent) => (parent as PageInfo).endCursor },
    },
  },
  CreateIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (parent) => (parent as { issue: GqlObject }).issue },
    },
  },
  CloseIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (parent) => (parent as { issue: GqlObject }).issue },
    },
  },
  CreatePullRequestPayload: {
    kind: 'object',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (parent) => (parent as { pullRequest: GqlObject }).pullRequest },
    },
  },
  MergePullRequestPayload: {
    kind: 'object',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (parent) => (parent as { pullRequest: GqlObject }).pullRequest },
    },
  },
  AddCommentPayload: {
    kind: 'object',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (parent) => (parent as { commentEdge: GqlObject }).commentEdge },
    },
  },
  __Type: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
      kind: { type: 'String', resolve: (parent) => (parent as { kind: string }).kind },
      description: { type: 'String', resolve: () => null },
      fields: {
        args: { includeDeprecated: { type: 'Boolean' } },
        type: '[__Field]',
        resolve: (parent) =>
          ((parent as { fields: string[] }).fields ?? []).map((name) => obj('__Field', { name })),
      },
      enumValues: {
        args: { includeDeprecated: { type: 'Boolean' } },
        type: '[__EnumValue]',
        resolve: (parent) =>
          ((parent as { enumValues: string[] }).enumValues ?? []).map((name) => obj('__EnumValue', { name })),
      },
    },
  },
  __Field: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
      description: { type: 'String', resolve: () => null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __EnumValue: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
      description: { type: 'String', resolve: () => null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  IssueState: { kind: 'enum', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'enum', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'enum', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  SearchType: { kind: 'enum', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function baseType(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

function isListType(type: string): boolean {
  return type.startsWith('[');
}

function isObjectLike(type: string): boolean {
  const base = baseType(type);
  if (SCALARS.has(base)) return false;
  const def = SCHEMA[base];
  return def !== undefined && (def.kind === 'object' || def.kind === 'interface');
}

interface GqlErrorEntry {
  message: string;
  path?: Array<string | number>;
}

function fragmentApplies(condition: string, parentType: string): boolean {
  if (condition === parentType) return true;
  const parent = SCHEMA[parentType];
  if (parent?.kind === 'interface' && parent.possibleTypes?.includes(condition)) return true;
  const cond = SCHEMA[condition];
  if (cond?.kind === 'interface' && cond.possibleTypes?.includes(parentType)) return true;
  return false;
}

/** Validate one operation against the schema; returns the error messages. */
function validateOperation(
  operation: OperationNode,
  fragments: Map<string, FragmentNode>,
  variables: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const usedVariables = new Set<string>();

  const checkDirectives = (directives: Array<{ name: string; args: Record<string, unknown> }>): boolean => {
    // Returns false when the selection is skipped by @skip/@include.
    for (const directive of directives) {
      const flag = directive.args.if;
      if (directive.name === 'skip' && flag === true) return false;
      if (directive.name === 'include' && flag === false) return false;
    }
    return true;
  };

  const checkSelections = (selections: SelectionNode[], parentType: string): void => {
    for (const selection of selections) {
      if (selection.kind === 'field') {
        if (!checkDirectives(selection.directives.map((d) => ({ ...d, args: resolveArguments(d.args, variables) })))) continue;
        for (const node of Object.values(selection.args)) collectVariables(node, usedVariables);
        const def = SCHEMA[parentType];
        if (selection.name === '__typename') {
          if (selection.selectionSet.length > 0) {
            errors.push(`Field "__typename" must not have a selection since type "String" has no subfields.`);
          }
          continue;
        }
        const field = def?.fields?.[selection.name];
        if (field === undefined) {
          errors.push(`Cannot query field "${selection.name}" on type "${parentType}".`);
          continue;
        }
        for (const [argName, argDef] of Object.entries(field.args ?? {})) {
          if (argDef.required === true && !(argName in selection.args)) {
            errors.push(`Field "${selection.name}" argument "${argName}" of type "${argDef.type}!" is required, but it was not provided.`);
          }
        }
        for (const argName of Object.keys(selection.args)) {
          if (field.args === undefined || !(argName in field.args)) {
            errors.push(`Unknown argument "${argName}" on field "${parentType}.${selection.name}".`);
          }
        }
        const returnBase = baseType(field.type);
        if (isObjectLike(field.type)) {
          if (selection.selectionSet.length === 0) {
            errors.push(`Field "${selection.name}" of type "${field.type}" must have a selection of subfields. Did you mean "${selection.name} { ... }"?`);
          } else {
            checkSelections(selection.selectionSet, returnBase);
          }
        } else if (selection.selectionSet.length > 0) {
          errors.push(`Field "${selection.name}" must not have a selection since type "${field.type}" has no subfields.`);
        }
      } else if (selection.kind === 'inline') {
        if (!checkDirectives(selection.directives.map((d) => ({ ...d, args: resolveArguments(d.args, variables) })))) continue;
        const condition = selection.typeCondition ?? parentType;
        if (SCHEMA[condition] === undefined) {
          errors.push(`Unknown type "${condition}".`);
          continue;
        }
        if (!fragmentApplies(condition, parentType)) {
          errors.push(`Fragment cannot be spread here as objects of type "${parentType}" can never be of type "${condition}".`);
          continue;
        }
        checkSelections(selection.selectionSet, condition);
      } else {
        if (!checkDirectives(selection.directives.map((d) => ({ ...d, args: resolveArguments(d.args, variables) })))) continue;
        const fragment = fragments.get(selection.name);
        if (fragment === undefined) {
          errors.push(`Unknown fragment "${selection.name}".`);
          continue;
        }
        if (!fragmentApplies(fragment.typeCondition, parentType)) {
          errors.push(`Fragment "${selection.name}" cannot be spread here as objects of type "${parentType}" can never be of type "${fragment.typeCondition}".`);
          continue;
        }
        checkSelections(fragment.selectionSet, fragment.typeCondition);
      }
    }
  };

  checkSelections(operation.selectionSet, rootType);
  for (const varDef of operation.variableDefinitions) {
    if (varDef.type.endsWith('!') && varDef.defaultValue === null) {
      const provided = variables[varDef.name];
      if (provided === undefined || provided === null) {
        errors.push(`Variable "$${varDef.name}" of required type "${varDef.type}" was not provided.`);
      }
    }
  }
  for (const name of usedVariables) {
    if (!operation.variableDefinitions.some((def) => def.name === name)) {
      errors.push(`Variable "$${name}" is not defined by operation "${operation.name ?? 'anonymous'}".`);
    }
  }
  return errors;
}

function collectVariables(node: { kind: string; name?: string; items?: unknown[]; fields?: Array<{ value: unknown }> }, into: Set<string>): void {
  if (node.kind === 'variable' && typeof node.name === 'string') into.add(node.name);
  if (Array.isArray(node.items)) for (const item of node.items) collectVariables(item as never, into);
  if (Array.isArray(node.fields)) for (const field of node.fields) collectVariables(field.value as never, into);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecState {
  variables: Readonly<Record<string, unknown>>;
  fragments: Map<string, FragmentNode>;
  errors: GqlErrorEntry[];
  ctx: GqlContext;
}

function directiveSkips(directives: Array<{ name: string; args: Record<string, unknown> }>): boolean {
  for (const directive of directives) {
    const flag = directive.args.if;
    if (directive.name === 'skip' && flag === true) return true;
    if (directive.name === 'include' && flag === false) return true;
  }
  return false;
}

function resolveDirectiveArgs(
  directives: Array<{ name: string; args: Record<string, ValueNode> }>,
  state: ExecState,
): Array<{ name: string; args: Record<string, unknown> }> {
  return directives.map((d) => ({ name: d.name, args: resolveArguments(d.args, state.variables) }));
}

/** Execute a selection set against a parent value; returns the output object. */
function executeSelections(
  parentType: string,
  parent: GqlValue,
  selections: SelectionNode[],
  state: ExecState,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const runtimeType = isGqlObject(parent) ? parent.__typename : parentType;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (directiveSkips(resolveDirectiveArgs(selection.directives, state))) continue;
      const responseKey = selection.alias ?? selection.name;
      const fieldPath = [...path, responseKey];
      if (selection.name === '__typename') {
        out[responseKey] = runtimeType;
        continue;
      }
      const def = SCHEMA[parentType];
      // For an interface parent (node), resolve the field from the runtime
      // type's table first: the interface only declares the field, the
      // concrete type knows how to answer it (e.g. node { id } must return
      // the repository's global id, not the interface's placeholder).
      let field = runtimeType !== parentType ? SCHEMA[runtimeType]?.fields?.[selection.name] : undefined;
      if (field === undefined) field = def?.fields?.[selection.name];
      if (field === undefined) {
        // Validation already reported this; keep the field null.
        out[responseKey] = null;
        continue;
      }
      const args = resolveArguments(selection.args, state.variables);
      let raw: unknown;
      try {
        raw = field.resolve(isGqlObject(parent) ? parent.value : parent, args, state.ctx);
      } catch (err) {
        state.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = completeValue(field.type, raw, selection.selectionSet, state, fieldPath);
    } else if (selection.kind === 'inline') {
      if (directiveSkips(resolveDirectiveArgs(selection.directives, state))) continue;
      const condition = selection.typeCondition ?? parentType;
      if (condition !== parentType && !fragmentApplies(condition, parentType)) continue;
      const sub = executeSelections(condition, parent, selection.selectionSet, state, path);
      Object.assign(out, sub);
    } else {
      if (directiveSkips(resolveDirectiveArgs(selection.directives, state))) continue;
      const fragment = state.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (!fragmentApplies(fragment.typeCondition, parentType)) continue;
      const sub = executeSelections(fragment.typeCondition, parent, fragment.selectionSet, state, path);
      Object.assign(out, sub);
    }
  }
  return out;
}

/** Shape a resolved field value against its declared type and sub-selection. */
function completeValue(
  type: string,
  raw: unknown,
  selectionSet: SelectionNode[],
  state: ExecState,
  path: Array<string | number>,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (isListType(type)) {
    if (!Array.isArray(raw)) return null;
    const itemType = baseType(type);
    return raw.map((element, index) => {
      if (element === null || element === undefined) return null;
      if (!isObjectLike(type)) return element;
      return executeSelections(itemType, element as GqlValue, selectionSet, state, [...path, index]);
    });
  }
  if (!isObjectLike(type)) return raw;
  if (!isGqlObject(raw)) return null;
  return executeSelections(baseType(type), raw, selectionSet, state, path);
}

/** Execute one parsed operation; returns the GraphQL response object. */
function executeOperation(
  store: ForgeStore,
  document: DocumentNode,
  operationName: string | undefined,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const operations = document.definitions.filter((d): d is OperationNode => d.kind === 'operation');
  const fragments = new Map<string, FragmentNode>();
  for (const def of document.definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation was provided.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const errors = validateOperation(operation, fragments, variables);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const state: ExecState = { variables, fragments, errors: [], ctx: { store } };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, obj(rootType, store), operation.selectionSet, state, []);
  if (state.errors.length > 0) {
    return { data, errors: state.errors };
  }
  return { data };
}

/** Execute one request body entry ({query, variables?, operationName?}). */
function executeRequestBody(store: ForgeStore, entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a "query" string.' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return { data: null, errors: [{ message: 'Variables must be a JSON object.' }] };
  }
  const operationName = record.operationName === undefined ? undefined : String(record.operationName);
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (err) {
    const message = err instanceof GraphQLSyntaxError ? err.message : err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message }] };
  }
  return executeOperation(store, document, operationName, variables);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function handleGraphql(ctx: RequestContext, store: ForgeStore): boolean {
  if (ctx.path !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }
  if (ctx.bodyMalformed) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  // A batched request is a JSON array of operation documents; it answers one
  // result per document, in order, with HTTP 200.
  if (Array.isArray(ctx.body)) {
    const results = ctx.body.map((item) => executeRequestBody(store, item));
    sendJson(ctx, 200, results);
    return true;
  }
  const body = bodyObject(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  sendJson(ctx, 200, executeRequestBody(store, body));
  return true;
}
