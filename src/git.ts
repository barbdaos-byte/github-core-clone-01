// Git smart HTTP: ref advertisement, protocol v2/v0 upload-pack and
// receive-pack. All four surfaces share one ForgeStore, so a commit pushed
// over git is the same history the REST surface reads, and vice versa.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack     (v2 fetch/ls-refs, v0 fetch)
//   POST /{owner}/{repo}.git/git-receive-pack    (v0, report-status + sideband)
//
// A missing repository is 404 on both services and the server stays up. A
// packfile is never fabricated: packs are built from the store's raw object
// bytes, and a received pack is parsed, checksummed and stored before any
// ref moves.

import { PKT_FLUSH, pktLine } from './gitobj.ts';
import type { RequestContext } from './http.ts';
import { requireAuth, sendBytes, sendError } from './http.ts';
import {
  decodePktLines,
  PackError,
  readPack,
  sidebandWrap,
  writePack,
} from './pack.ts';
import type { ForgeStore, Repo } from './store.ts';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';
const ZERO_OID = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- advertisements

/** All refs of a repo, branches then tags, each sorted by name. */
function refList(repo: Repo): Array<{ oid: string; name: string }> {
  const refs: Array<{ oid: string; name: string }> = [];
  for (const [branch, sha] of [...repo.branches.entries()].sort()) {
    refs.push({ oid: sha, name: `refs/heads/${branch}` });
  }
  for (const [tag, sha] of [...repo.tags.entries()].sort()) {
    refs.push({ oid: sha, name: `refs/tags/${tag}` });
  }
  return refs;
}

function v0Advertisement(service: string, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps =
    service === UPLOAD_PACK
      ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/main filter object-format=sha1 agent=github-core-clone-01/1.0.0'
      : 'report-status side-band-64k delete-refs ofs-delta quiet object-format=sha1 agent=github-core-clone-01/1.0.0';
  const refs = refList(repo);
  if (refs.length === 0) {
    // An empty repository advertises the zero id for the capabilities pseudo-ref, as git does.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD first, carrying the capabilities (git's own v0 form); then the refs.
    const tip = repo.branches.get(repo.defaultBranch) ?? refs[0]?.oid ?? ZERO_OID;
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const entry of refs) {
      parts.push(pktLine(`${entry.oid} ${entry.name}\n`));
      // An annotated tag peels to its commit, advertised on a ^{} line.
      const peeled = repo.peelTag(entry.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${entry.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2',
    'agent=github-core-clone-01/1.0.0',
    'ls-refs=unborn',
    'fetch=shallow wait-for-done',
    'server-option',
    'object-format=sha1',
    'object-info',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------- request parsing

interface V2Request {
  command: string;
  args: string[];
}

/**
 * Parse a protocol v2 request: `command=<name>`, optional agent /
 * object-format lines, a delim, then argument lines, then a flush.
 * Single pass: each packet payload is decoded at most once, and the
 * command is taken from the first data packet.
 */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = decodePktLines(body);
  let command: string | null = null;
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (command === null) {
        if (!text.startsWith('command=')) {
          throw new PackError(`expected a command line, got ${JSON.stringify(text.slice(0, 40))}`);
        }
        command = text.slice('command='.length).replace(/\n$/, '');
      }
      // Agent / object-format lines before the delim are acknowledged, not args.
      continue;
    }
    args.push(text);
  }
  if (command === null) throw new PackError('empty protocol v2 request');
  return { command, args };
}

interface V0FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/**
 * Parse a protocol v0 fetch request: two sections. Section one (wants, with
 * shallow/deepen) ends at the first flush; section two (haves, done) ends at
 * the second flush. The first want line may carry capabilities after the oid.
 */
function parseV0Fetch(body: Buffer): V0FetchRequest {
  const { packets } = decodePktLines(body);
  const request: V0FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
  };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0] as string;
        request.wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        request.shallow.push(line.slice(8));
      } else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7), 10);
        if (Number.isSafeInteger(n) && n > 0) request.depth = n;
      } else if (line.startsWith('deepen-since ')) {
        const n = Number.parseInt(line.slice(13), 10);
        if (Number.isSafeInteger(n)) request.deepenSince = n;
      } else if (line.startsWith('deepen-not ')) {
        request.deepenNot.push(line.slice(11));
      }
    } else if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).split(' ')[0] as string);
    } else if (line === 'done') {
      break;
    }
  }
  return request;
}

interface V2FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseV2Fetch(args: readonly string[]): V2FetchRequest {
  const request: V2FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
  };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isSafeInteger(n) && n > 0) request.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13), 10);
      if (Number.isSafeInteger(n)) request.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11));
    // thin-pack, no-progress, ofs-delta, filter, agent, object-format and
    // done are acknowledged by being understood, not by changing the pack:
    // this server sends self-contained packs (no deltas), which satisfy a
    // thin-pack request, and no filter is applied.
  }
  return request;
}

// ---------------------------------------------------------------- fetch responses

/** The acknowledgment lines for a fetch: ACK each held have, then ready; NAK when none match. */
function ackLines(repo: Repo, haves: readonly string[]): string[] {
  if (haves.length === 0) return [];
  const held = haves.filter((have) => repo.objects.has(have));
  if (held.length === 0) return ['NAK\n'];
  return [...held.map((have) => `ACK ${have}\n`), 'ready\n'];
}

function handleLsRefs(ctx: RequestContext, repo: Repo, request: V2Request): void {
  const args = request.args;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  // HEAD is reported only when symrefs were requested, and only when it
  // matches the requested prefixes (a client asks for it with `ref-prefix HEAD`).
  if (symrefs && matches('HEAD')) {
    const tip = repo.branches.get(repo.defaultBranch);
    if (tip !== undefined) {
      parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of refList(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = repo.peelTag(ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${UPLOAD_PACK}-result`);
}

function handleFetchV2(ctx: RequestContext, repo: Repo, request: V2Request): void {
  const { command, args } = request;
  if (command !== 'fetch') {
    sendError(ctx, 400, `unsupported protocol v2 command ${JSON.stringify(command)}`);
    return;
  }
  const fetchRequest = parseV2Fetch(args);
  const plan = repo.fetchPlan(fetchRequest.wants, fetchRequest.haves, fetchRequest.shallow, fetchRequest.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (fetchRequest.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const line of ackLines(repo, fetchRequest.haves)) parts.push(pktLine(line));
    parts.push(PKT_FLUSH);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack, 1));
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${UPLOAD_PACK}-result`);
}

function handleFetchV0(ctx: RequestContext, repo: Repo, body: Buffer): void {
  const request = parseV0Fetch(body);
  const plan = repo.fetchPlan(request.wants, request.haves, request.shallow, request.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    for (const line of ackLines(repo, request.haves)) parts.push(pktLine(line));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(pack, 1));
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${UPLOAD_PACK}-result`);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse a receive-pack body: command pkt-lines up to the first flush, then
 * the raw packfile. Returns the commands and the pack bytes (empty when the
 * push is delete-only).
 */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, consumed } = decodePktLines(body, true);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities ride on the first command
    line = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (match === null) throw new PackError(`bad receive-pack command ${JSON.stringify(line.slice(0, 80))}`);
    commands.push({
      oldOid: match[1] as string,
      newOid: match[2] as string,
      ref: match[3] as string,
    });
  }
  if (commands.length === 0) throw new PackError('receive-pack sent no commands');
  return { commands, pack: body.subarray(consumed) };
}

/** True when `ancestor` is an ancestor of `tip` (or the same commit). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  return repo.isAncestor(ancestor, tip);
}

function handleReceivePack(ctx: RequestContext, repo: Repo, body: Buffer): void {
  let commands: PushCommand[];
  let pack: Buffer;
  try {
    ({ commands, pack } = parseReceivePack(body));
  } catch (err) {
    sendError(ctx, 400, err instanceof Error ? err.message : 'bad receive-pack request');
    return;
  }

  // Unpack first: a refused ref update must still unpack, and a corrupt
  // pack is reported in-band as an unpack failure, never as a crash.
  const reportLines: string[] = [];
  if (pack.length > 0) {
    try {
      const read = readPack(pack, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      for (const [oid, object] of read.objects) {
        void oid;
        repo.putObject(object.type, object.data);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unpack failed';
      const report = Buffer.concat([
        pktLine(`unpack ${detail}\n`),
        PKT_FLUSH,
      ]);
      sendBytes(ctx, 200, Buffer.concat([sidebandWrap(report, 1), PKT_FLUSH]), `application/x-${RECEIVE_PACK}-result`);
      return;
    }
  }
  reportLines.push('unpack ok\n');

  for (const command of commands) {
    const isBranch = command.ref.startsWith('refs/heads/');
    const isTag = command.ref.startsWith('refs/tags/');
    const current =
      (isBranch ? repo.branches.get(command.ref.slice('refs/heads/'.length)) : undefined) ??
      (isTag ? repo.tags.get(command.ref.slice('refs/tags/'.length)) : undefined) ??
      ZERO_OID;

    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        if (isBranch) repo.branches.delete(command.ref.slice('refs/heads/'.length));
        else if (isTag) repo.tags.delete(command.ref.slice('refs/tags/'.length));
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }

    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (isBranch && target.type !== 'commit') {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (isTag && target.type !== 'commit' && target.type !== 'tag') {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }

    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} already exists\n`);
        continue;
      }
      if (isBranch) repo.branches.set(command.ref.slice('refs/heads/'.length), command.newOid);
      else if (isTag) repo.tags.set(command.ref.slice('refs/tags/'.length), command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }

    // Update: the old value must match, and a commit update must fast-forward.
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (isBranch && target.type === 'commit' && !isAncestor(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (isBranch) repo.branches.set(command.ref.slice('refs/heads/'.length), command.newOid);
    else if (isTag) repo.tags.set(command.ref.slice('refs/tags/'.length), command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  sendBytes(
    ctx,
    200,
    Buffer.concat([sidebandWrap(report, 1), PKT_FLUSH]),
    `application/x-${RECEIVE_PACK}-result`,
  );
}

// ---------------------------------------------------------------- router

/**
 * Handle a git smart-HTTP request. Returns true when the path is a git path
 * (even as an error); false otherwise.
 */
export function handleGit(ctx: RequestContext, store: ForgeStore): boolean {
  const { method, path } = ctx;
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const suffix = match[3] as string;

  // Smart HTTP is a protected surface: no token is 401.
  if (!requireAuth(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }

  // The repository belongs to the viewer; any other owner is 404, never 403.
  const repo = owner === store.viewer ? store.getRepo(owner, name) : null;

  if (method === 'GET' && suffix === 'info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
      sendError(ctx, 400, 'service must be git-upload-pack or git-receive-pack');
      return true;
    }
    if (repo === null) {
      sendError(ctx, 404, 'Repository not found');
      return true;
    }
    const contentType = `application/x-${service}-advertisement`;
    if (service === UPLOAD_PACK && (ctx.req.headers['git-protocol'] ?? '') === 'version=2') {
      sendBytes(ctx, 200, v2Advertisement(), contentType);
      return true;
    }
    sendBytes(ctx, 200, v0Advertisement(service, repo), contentType);
    return true;
  }

  if (method === 'POST' && suffix === UPLOAD_PACK) {
    if (repo === null) {
      sendError(ctx, 404, 'Repository not found');
      return true;
    }
    // A malformed request is a 400, never a crash: the server must stay up.
    try {
      if ((ctx.req.headers['git-protocol'] ?? '') === 'version=2') {
        // Parse once: the handlers take the parsed request, not the raw body.
        const request = parseV2Request(ctx.rawBody);
        if (request.command === 'ls-refs') handleLsRefs(ctx, repo, request);
        else if (request.command === 'fetch') handleFetchV2(ctx, repo, request);
        else sendError(ctx, 400, `unsupported protocol v2 command ${JSON.stringify(request.command)}`);
      } else {
        handleFetchV0(ctx, repo, ctx.rawBody);
      }
    } catch (err) {
      if (!ctx.res.writableEnded) {
        sendError(ctx, 400, err instanceof Error ? err.message : 'bad git-upload-pack request');
      }
    }
    return true;
  }

  if (method === 'POST' && suffix === RECEIVE_PACK) {
    if (repo === null) {
      sendError(ctx, 404, 'Repository not found');
      return true;
    }
    try {
      handleReceivePack(ctx, repo, ctx.rawBody);
    } catch (err) {
      if (!ctx.res.writableEnded) {
        sendError(ctx, 400, err instanceof Error ? err.message : 'bad git-receive-pack request');
      }
    }
    return true;
  }

  sendError(ctx, 404, 'Not Found');
  return true;
}
