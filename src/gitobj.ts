// The git object model: content-addressed blobs, trees and commits with real
// SHA-1 ids, shared by the REST contents/branches/commits surface and (in a
// later phase) the smart-HTTP packfile surface. One history, one store.
//
// Object formats follow git exactly:
//   blob   "blob <len>\0<bytes>"
//   tree   "tree <len>\0" + entries "<mode> <name>\0<20-byte sha>"
//   commit "commit <len>\0tree <sha>\nparent <sha>\n...author ...\ncommitter ...\n\n<message>"

import { sha1, trialNowSec } from './util.ts';

export interface TreeEntry {
  name: string;
  mode: string; // '100644' for a file, '40000' for a directory
  sha: string;
  type: 'blob' | 'tree';
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface CommitObj {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
}

/** The SHA-1 id of an object of `type` holding `data`. */
export function objectSha(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

/** True when `value` is a 40-hex object id. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a raw tree object into its entries (git order is preserved). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) {
      throw new Error('tree object is malformed');
    }
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ name, mode, sha, type: mode === '40000' ? 'tree' : 'blob' });
    offset = nul + 21;
  }
  return entries;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a raw commit object (headers + blank line + message). */
export function parseCommit(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse a raw annotated-tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

/** Split "Name <email> 1234567890 +0000" into its parts (best effort). */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return {
    name: (match[1] as string).trim(),
    email: match[2] as string,
    timestamp: Number.parseInt(match[3] as string, 10),
  };
}

/** The raw bytes of a commit object (the exact bytes its SHA-1 covers). */
export function buildCommitBytes(input: {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp?: number;
}): Buffer {
  const timestamp = input.timestamp ?? trialNowSec();
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.authorName} <${input.authorEmail}> ${timestamp} +0000`);
  lines.push(`committer ${input.authorName} <${input.authorEmail}> ${timestamp} +0000`);
  const text = `${lines.join('\n')}\n\n${input.message}`;
  return Buffer.from(text, 'utf8');
}

/** Build a commit object and return it (its SHA is content-addressed). */
export function makeCommit(input: {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp?: number;
}): CommitObj {
  const timestamp = input.timestamp ?? trialNowSec();
  const bytes = buildCommitBytes({ ...input, timestamp });
  const sha = objectSha('commit', bytes);
  return {
    sha,
    tree: input.tree,
    parents: [...input.parents],
    message: input.message,
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    committerName: input.authorName,
    committerEmail: input.authorEmail,
    timestamp,
  };
}

/** SHA-1 of a git blob object holding `content`. */
export function blobSha(content: Buffer): string {
  return objectSha('blob', content);
}

/** SHA-1 of a git tree object holding `entries` (sorted git order). */
export function treeSha(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.type === 'tree' ? `${a.name}/` : a.name;
    const bKey = b.type === 'tree' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.from(`tree ${body.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, body]));
}

/** The raw bytes of a tree object (for a future packfile writer). */
export function treeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.type === 'tree' ? `${a.name}/` : a.name;
    const bKey = b.type === 'tree' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pkt-line

/** One pkt-line packet: 4 hex length digits (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65_520) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** A pkt-line flush packet (0000). */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');

/** A pkt-line delim packet (0001). */
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

/** A pkt-line response-end packet (0002). */
export const PKT_END: Buffer = Buffer.from('0002', 'ascii');
