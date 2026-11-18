// The forge store: one in-memory store for every surface (REST, git,
// GraphQL, MCP). Repositories hold a real git object graph — blobs, trees
// and commits with content-addressed SHA-1 ids — so a file written through
// the contents API is the same history a later clone serves.
//
// Everything is deterministic: ids come from counters, SHAs from content,
// timestamps from the trial's now. No wall clock, no Math.random.

import {
  blobSha,
  buildCommitBytes,
  makeCommit,
  objectSha,
  parseCommit,
  parseIdentity,
  parseTag,
  parseTree,
  treeBytes,
  treeSha,
  type CommitObj,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { b64encode, deterministicId, trialNowIso, trialNowSec } from './util.ts';
import { viewerLogin } from './viewer.ts';

export type IssueState = 'open' | 'closed';
export type PullState = 'open' | 'closed';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  comments: Comment[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  files: PullFile[];
  user: { login: string };
  created_at: string;
  updated_at: string;
}

/** A repository and its whole history. */
export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  privateFlag: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly created_at: string;
  updated_at: string;

  /** Raw object bytes by SHA-1: the single source of truth for packs. */
  readonly objects = new Map<string, { type: GitObjectType; data: Buffer }>();
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, CommitObj>();
  readonly branches = new Map<string, string>();
  readonly tags = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  issueSeq = 0;
  pullSeq = 0;
  commentSeq = 0;

  constructor(owner: string, name: string, privateFlag: boolean, description: string, defaultBranch: string) {
    this.id = deterministicId(`repo:${owner}/${name}`, 5000);
    this.name = name;
    this.owner = owner;
    this.privateFlag = privateFlag;
    this.description = description;
    this.defaultBranch = defaultBranch;
    this.created_at = trialNowIso();
    this.updated_at = this.created_at;
  }

  get full_name(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The commit a ref (branch name or SHA) resolves to, or null. */
  resolveRef(ref: string): string | null {
    if (this.branches.has(ref)) return this.branches.get(ref) ?? null;
    if (this.tags.has(ref)) return this.tags.get(ref) ?? null;
    if (this.commits.has(ref)) return ref;
    return null;
  }

  /** The tip commit SHA of the default branch, or null when unborn. */
  defaultTip(): string | null {
    return this.branches.get(this.defaultBranch) ?? null;
  }

  /**
   * Store an object by its raw bytes (the SHA-1 is recomputed from them) and
   * keep the parsed indexes in step, so a pushed object is byte-identical
   * when it is cloned back and usable by the REST merge logic. Returns the SHA.
   */
  putObject(type: GitObjectType, data: Buffer): string {
    const sha = objectSha(type, data);
    this.objects.set(sha, { type, data });
    if (type === 'blob') {
      this.blobs.set(sha, data);
    } else if (type === 'tree') {
      this.trees.set(sha, parseTree(data));
    } else if (type === 'commit') {
      const parsed = parseCommit(data);
      const author = parseIdentity(parsed.author);
      const committer = parseIdentity(parsed.committer);
      this.commits.set(sha, {
        sha,
        tree: parsed.tree,
        parents: parsed.parents,
        message: parsed.message,
        authorName: author.name,
        authorEmail: author.email,
        committerName: committer.name,
        committerEmail: committer.email,
        timestamp: author.timestamp,
      });
    }
    return sha;
  }

  /** The commit a tag object points at, or null when `sha` is not a tag. */
  peelTag(sha: string): string | null {
    const object = this.objects.get(sha);
    if (object === undefined || object.type !== 'tag') return null;
    const target = parseTag(object.data).object;
    return /^[0-9a-f]{40}$/.test(target) ? target : null;
  }

  /**
   * Every object reachable from `roots`: commit → tree + parents, tag →
   * target, tree → entries (gitlinks skipped). `shallowRoots` are held but
   * their parents are not followed (a shallow clone's boundary). Throws on a
   * missing object unless `allowMissing` is set.
   */
  reachable(
    roots: Iterable<string>,
    options: { allowMissing?: boolean; shallowRoots?: ReadonlySet<string> } = {},
  ): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) {
      if (/^[0-9a-f]{40}$/.test(root) && root !== '0000000000000000000000000000000000000000') queue.push(root);
    }
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) {
        if (options.allowMissing) continue;
        throw new Error(`object ${oid} is missing from the store`);
      }
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!options.shallowRoots?.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
          queue.push(entry.sha);
        }
      }
    }
    return seen;
  }

  /**
   * The fetch plan for a set of wants: which objects to send, which commits
   * are the new shallow boundary, and which previously-shallow commits are
   * now complete. `haves` are commits the client already holds; `shallowIn`
   * are its shallow boundaries (held, but their parents are not); `depth`
   * caps the generations from the wants (1 = the wants only).
   */
  fetchPlan(
    wants: readonly string[],
    haves: readonly string[],
    shallowIn: readonly string[],
    depth: number | null,
  ): { objects: Array<{ type: GitObjectType; data: Buffer; oid: string }>; shallow: string[]; unshallow: string[] } {
    const haveSet = new Set(haves);
    const shallowInSet = new Set(shallowIn);
    // BFS from the wants, generation 1 for a want, +1 per parent step.
    const generation = new Map<string, number>();
    const included = new Set<string>();
    const tagObjects = new Set<string>();
    const queue: Array<[string, number]> = wants.map((want) => [want, 1] as [string, number]);
    while (queue.length > 0) {
      const [oid, gen] = queue.shift() as [string, number];
      const seenGen = generation.get(oid);
      if (seenGen !== undefined && seenGen <= gen) continue;
      generation.set(oid, gen);
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        tagObjects.add(oid);
        const target = parseTag(object.data).object;
        if (/^[0-9a-f]{40}$/.test(target)) queue.push([target, gen]);
        continue;
      }
      if (object.type !== 'commit') continue;
      const isHeld = haveSet.has(oid);
      const isBoundary = shallowInSet.has(oid);
      if (isHeld && !isBoundary) continue; // fully held: skip it and its parents
      if (!isHeld) included.add(oid);
      // A held shallow boundary is not re-sent, but its parents are not held.
      if (depth === null || gen + 1 <= depth) {
        const commit = parseCommit(object.data);
        for (const parent of commit.parents) queue.push([parent, gen + 1]);
      }
    }
    // The objects to send: the included commits and tags plus the tree
    // closure of the included commits only (a parent outside the depth cut
    // contributes nothing), minus everything the client already holds.
    const heldObjects = this.reachable(haves, { allowMissing: true, shallowRoots: shallowInSet });
    const send = new Set<string>();
    const walkTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (send.has(oid)) continue;
        const object = this.objects.get(oid);
        if (object === undefined) continue;
        send.add(oid);
        if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) {
            if (entry.mode === '160000') continue; // gitlink: not held here
            stack.push(entry.sha);
          }
        }
      }
    };
    for (const oid of included) {
      send.add(oid);
      const commit = parseCommit((this.objects.get(oid) as { data: Buffer }).data);
      walkTree(commit.tree);
    }
    for (const oid of tagObjects) send.add(oid);
    for (const oid of [...send]) {
      if (heldObjects.has(oid)) send.delete(oid);
    }
    const typeRank: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
    const objects = [...send]
      .map((oid) => {
        const object = this.objects.get(oid) as { type: GitObjectType; data: Buffer };
        return { type: object.type, data: object.data, oid };
      })
      .sort((a, b) => typeRank[a.type] - typeRank[b.type] || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    // Shallow boundaries: an included commit with parents, cut off by the
    // depth limit, or whose parents are all absent from the pack and the
    // client's holdings.
    const shallow: string[] = [];
    for (const oid of included) {
      const commit = parseCommit((this.objects.get(oid) as { data: Buffer }).data);
      if (commit.parents.length === 0) continue;
      const atDepthCut = depth !== null && generation.get(oid) === depth;
      const parentsAbsent = commit.parents.every((parent) => !included.has(parent) && !haveSet.has(parent));
      if (atDepthCut || parentsAbsent) shallow.push(oid);
    }
    // Unshallow: a previously-shallow commit whose parents are now present.
    const unshallow: string[] = [];
    for (const oid of shallowIn) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit.parents.every((parent) => included.has(parent) || haveSet.has(parent))) {
        unshallow.push(oid);
      }
    }
    return { objects, shallow, unshallow };
  }

  /** All ancestors of `sha` (inclusive), newest first. */
  ancestors(sha: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack = [sha];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commits.get(current);
      if (commit === undefined) continue;
      out.push(current);
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }

  /**
   * True when `ancestor` is an ancestor of `tip` (or the same commit).
   * Early-exit reachability walk: unlike ancestors(), it stops the moment
   * the ancestor is found as a stored commit, so a fast-forward update
   * whose old tip is the direct parent costs O(1) instead of O(history).
   * A true non-ancestor still walks the whole reachable set, which is
   * necessary to prove absence. Equality is only reported for a commit
   * that is actually in the store, exactly like ancestors().includes().
   */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commits.get(current);
      if (commit === undefined) continue;
      if (current === ancestor) return true;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** The merge-base of two tips (first common ancestor), or null. */
  mergeBase(a: string, b: string): string | null {
    const aAncestors = new Set(this.ancestors(a));
    for (const candidate of this.ancestors(b)) {
      if (aAncestors.has(candidate)) return candidate;
    }
    return null;
  }

  /** The entries of a stored tree, or an empty list when unknown. */
  treeEntries(sha: string): TreeEntry[] {
    return this.trees.get(sha) ?? [];
  }

  /** Flatten a tree into path -> {sha, content} for every file in it. */
  flattenTree(treeShaValue: string, prefix = ''): Map<string, { sha: string; content: Buffer }> {
    const out = new Map<string, { sha: string; content: Buffer }>();
    const walk = (tree: string, base: string): void => {
      for (const entry of this.treeEntries(tree)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.type === 'blob') {
          const content = this.blobs.get(entry.sha);
          if (content !== undefined) out.set(path, { sha: entry.sha, content });
        } else {
          walk(entry.sha, path);
        }
      }
    };
    walk(treeShaValue, prefix);
    return out;
  }

  /**
   * Write `content` at `path` on top of `baseTree` ('' for an empty tree) and
   * return the new root tree SHA, storing every intermediate tree and blob.
   */
  writePath(baseTree: string, path: string, content: Buffer): string {
    const blob = blobSha(content);
    this.blobs.set(blob, content);
    this.objects.set(blob, { type: 'blob', data: content });
    const segments = path.split('/').filter((s) => s !== '');
    const build = (tree: string, depth: number): string => {
      const entries = [...this.treeEntries(tree)];
      const segment = segments[depth] as string;
      if (depth === segments.length - 1) {
        const index = entries.findIndex((e) => e.name === segment && e.type === 'blob');
        const entry: TreeEntry = { name: segment, mode: '100644', sha: blob, type: 'blob' };
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
        const next = treeSha(entries);
        this.trees.set(next, entries);
        this.objects.set(next, { type: 'tree', data: treeBytes(entries) });
        return next;
      }
      const index = entries.findIndex((e) => e.name === segment && e.type === 'tree');
      const childTree = index >= 0 ? (entries[index] as TreeEntry).sha : '';
      const nextChild = build(childTree, depth + 1);
      const entry: TreeEntry = { name: segment, mode: '40000', sha: nextChild, type: 'tree' };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      const next = treeSha(entries);
      this.trees.set(next, entries);
      this.objects.set(next, { type: 'tree', data: treeBytes(entries) });
      return next;
    };
    return build(baseTree, 0);
  }

  /**
   * Remove `path` from `baseTree` and return the new root tree SHA, or null
   * when the path is not in the tree.
   */
  removePath(baseTree: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    const remove = (tree: string, depth: number): string | null => {
      const entries = [...this.treeEntries(tree)];
      const segment = segments[depth] as string;
      const index = entries.findIndex((e) => e.name === segment);
      if (index < 0) return null;
      if (depth === segments.length - 1) {
        entries.splice(index, 1);
        const next = treeSha(entries);
        this.trees.set(next, entries);
        this.objects.set(next, { type: 'tree', data: treeBytes(entries) });
        return next;
      }
      const entry = entries[index] as TreeEntry;
      if (entry.type !== 'tree') return null;
      const nextChild = remove(entry.sha, depth + 1);
      if (nextChild === null) return null;
      if (this.treeEntries(nextChild).length === 0) entries.splice(index, 1);
      else entries[index] = { ...entry, sha: nextChild };
      const next = treeSha(entries);
      this.trees.set(next, entries);
      this.objects.set(next, { type: 'tree', data: treeBytes(entries) });
      return next;
    };
    return remove(baseTree, 0);
  }

  /** Resolve `path` in `tree` to a blob entry, a directory listing, or null. */
  lookupPath(
    tree: string,
    path: string,
  ): { kind: 'file'; entry: TreeEntry; content: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) return { kind: 'dir', entries: this.treeEntries(tree) };
    let current = tree;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const segment = segments[depth] as string;
      const entry = this.treeEntries(current).find((e) => e.name === segment);
      if (entry === undefined) return null;
      if (depth === segments.length - 1) {
        if (entry.type === 'blob') {
          const content = this.blobs.get(entry.sha);
          if (content === undefined) return null;
          return { kind: 'file', entry, content };
        }
        return { kind: 'dir', entries: this.treeEntries(entry.sha) };
      }
      if (entry.type !== 'tree') return null;
      current = entry.sha;
    }
    return null;
  }

  /** Commit `tree` on `branch` with `parents` and return the commit. */
  commitOnBranch(branch: string, tree: string, parents: string[], message: string): CommitObj {
    const login = viewerLogin();
    const commit = makeCommit({
      tree,
      parents,
      message,
      authorName: login,
      authorEmail: `${login}@example.invalid`,
      timestamp: trialNowSec(),
    });
    const bytes = buildCommitBytes({
      tree,
      parents,
      message,
      authorName: login,
      authorEmail: `${login}@example.invalid`,
      timestamp: commit.timestamp,
    });
    this.objects.set(commit.sha, { type: 'commit', data: bytes });
    this.commits.set(commit.sha, commit);
    this.branches.set(branch, commit.sha);
    this.updated_at = trialNowIso();
    return commit;
  }

  // ---------------------------------------------------------- domain writes
  // These are the shared mutations every surface calls (REST, GraphQL, MCP),
  // so a change made on one surface is visible on the others by construction.

  /** Create an issue on this repository. */
  createIssue(title: string, body: string, labels: Label[] = []): Issue {
    this.issueSeq += 1;
    const issue: Issue = {
      id: 1000 + this.issueSeq,
      number: this.issueSeq,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      user: { login: this.owner },
      created_at: trialNowIso(),
      updated_at: trialNowIso(),
      seq: this.issueSeq,
    };
    this.issues.push(issue);
    return issue;
  }

  /** Add a comment to an issue. */
  addComment(issue: Issue, body: string): Comment {
    this.commentSeq += 1;
    const comment: Comment = {
      id: this.commentSeq,
      body,
      user: { login: this.owner },
      created_at: trialNowIso(),
      updated_at: trialNowIso(),
    };
    issue.comments.push(comment);
    issue.updated_at = trialNowIso();
    return comment;
  }

  /** Create a pull request between two branches; an error when a branch does not resolve. */
  createPull(
    headRef: string,
    baseRef: string,
    title: string,
    body: string,
  ): { ok: true; pull: Pull } | { ok: false; error: string } {
    const headSha = this.branches.get(headRef);
    const baseSha = this.branches.get(baseRef);
    if (headSha === undefined) return { ok: false, error: `head branch '${headRef}' does not exist` };
    if (baseSha === undefined) return { ok: false, error: `base branch '${baseRef}' does not exist` };
    const headCommit = this.commits.get(headSha);
    const baseCommit = this.commits.get(baseSha);
    if (headCommit === undefined || baseCommit === undefined) {
      return { ok: false, error: 'head or base does not name a commit' };
    }
    const files = diffTrees(this, baseCommit.tree, headCommit.tree);
    this.pullSeq += 1;
    const pull: Pull = {
      id: 2000 + this.pullSeq,
      number: this.pullSeq,
      title,
      body,
      state: 'open',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      merged: false,
      mergeable: true,
      merged_at: null,
      merge_commit_sha: null,
      files,
      user: { login: this.owner },
      created_at: trialNowIso(),
      updated_at: trialNowIso(),
    };
    this.pulls.push(pull);
    return { ok: true, pull };
  }

  /**
   * Squash-merge a pull request onto its base branch: the three-way merge
   * from the merge base, with a conflict when a path changed on both sides
   * to different content. The merge commit is stored with its raw bytes,
   * so a later clone serves it (REST used to store only the parsed commit).
   */
  squashMerge(
    pull: Pull,
    options: { method?: string; commitTitle?: string; commitMessage?: string } = {},
  ): { ok: true; sha: string } | { ok: false; error: string } {
    if (pull.merged || pull.state === 'closed') {
      return { ok: false, error: 'pull request is already merged or closed' };
    }
    const baseTip = this.branches.get(pull.base.ref);
    const headTip = this.branches.get(pull.head.ref);
    if (baseTip === undefined || headTip === undefined) {
      return { ok: false, error: 'head or base branch no longer exists' };
    }
    const baseCommit = this.commits.get(baseTip);
    const headCommit = this.commits.get(headTip);
    if (baseCommit === undefined || headCommit === undefined) {
      return { ok: false, error: 'head or base does not name a commit' };
    }
    const mergeBaseSha = this.mergeBase(headTip, baseTip);
    if (mergeBaseSha === null) {
      return { ok: false, error: 'no merge base: the branches have no common history' };
    }
    const baseTreeCommit = this.commits.get(mergeBaseSha);
    if (baseTreeCommit === undefined) {
      return { ok: false, error: 'merge base does not name a commit' };
    }
    // Three-way merge: a path changed on both sides (against the merge base)
    // with different content is a conflict.
    const baseFiles = this.flattenTree(baseTreeCommit.tree);
    const oursFiles = this.flattenTree(baseCommit.tree);
    const theirsFiles = this.flattenTree(headCommit.tree);
    const names = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const name of names) {
      const base = baseFiles.get(name);
      const ours = oursFiles.get(name);
      const theirs = theirsFiles.get(name);
      const oursChanged = (ours?.sha ?? null) !== (base?.sha ?? null);
      const theirsChanged = (theirs?.sha ?? null) !== (base?.sha ?? null);
      if (oursChanged && theirsChanged && (ours?.sha ?? null) !== (theirs?.sha ?? null)) {
        return { ok: false, error: `merge conflict in ${name}` };
      }
    }
    // The squash tree: ours, with theirs' changes applied.
    let mergedTree = baseCommit.tree;
    for (const name of names) {
      const base = baseFiles.get(name);
      const theirs = theirsFiles.get(name);
      const theirsChanged = (theirs?.sha ?? null) !== (base?.sha ?? null);
      if (!theirsChanged) continue;
      if (theirs === undefined) {
        const next = this.removePath(mergedTree, name);
        if (next !== null) mergedTree = next;
      } else {
        mergedTree = this.writePath(mergedTree, name, theirs.content);
      }
    }
    const method = options.method ?? 'squash';
    const commitTitle = options.commitTitle ?? pull.title;
    const commitMessage = options.commitMessage ?? '';
    const message = method === 'squash'
      ? `${commitTitle} (#${pull.number})${commitMessage === '' ? '' : `\n\n${commitMessage}`}`
      : commitTitle;
    const squash = makeCommit({
      tree: mergedTree,
      parents: [baseTip],
      message,
      authorName: this.owner,
      authorEmail: `${this.owner}@example.invalid`,
      timestamp: trialNowSec(),
    });
    const bytes = buildCommitBytes({
      tree: mergedTree,
      parents: [baseTip],
      message,
      authorName: this.owner,
      authorEmail: `${this.owner}@example.invalid`,
      timestamp: squash.timestamp,
    });
    this.objects.set(squash.sha, { type: 'commit', data: bytes });
    this.commits.set(squash.sha, squash);
    this.branches.set(pull.base.ref, squash.sha);
    this.updated_at = trialNowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = trialNowIso();
    pull.merge_commit_sha = squash.sha;
    pull.updated_at = trialNowIso();
    return { ok: true, sha: squash.sha };
  }
}

/** The whole forge: repositories keyed by owner/name, plus the viewer. */
export class ForgeStore {
  readonly viewer: string;
  private readonly repos = new Map<string, Repo>();
  private repoSeq = 0;

  constructor() {
    this.viewer = viewerLogin();
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  /** Create a repository under the viewer; null when the name is taken. */
  createRepo(name: string, privateFlag: boolean, description: string, defaultBranch = 'main'): Repo | null {
    if (this.repos.has(this.key(this.viewer, name))) return null;
    this.repoSeq += 1;
    const repo = new Repo(this.viewer, name, privateFlag, description, defaultBranch);
    this.repos.set(this.key(this.viewer, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer);
  }
}

// ---------------------------------------------------------------- line diff

/** Count added/removed lines between two texts (prefix/suffix diff). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/** The changed files between two trees, with line counts. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): PullFile[] {
  const base = repo.flattenTree(baseTree);
  const head = repo.flattenTree(headTree);
  const files: PullFile[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b !== undefined && h === undefined) {
      const deletions = b.content.toString('utf8').split('\n').length;
      files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const additions = h.content.toString('utf8').split('\n').length;
      files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
      const counts = lineDiffCounts(b.content.toString('utf8'), h.content.toString('utf8'));
      files.push({ filename: name, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return files;
}

/** Base64 content helper for the contents API. */
export function contentBase64(content: Buffer): string {
  return b64encode(content);
}
