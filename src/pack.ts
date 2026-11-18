// Packfile codec, pkt-line decoding and sideband framing for git smart HTTP.
//
// Formats follow git exactly (and the kit's git-client.ts, which is the
// authority for what the suite accepts):
//   packfile  "PACK" + uint32 version (2) + uint32 count + entries
//             + 20-byte SHA-1 trailer over everything before it.
//   entry     type/size varint, then (for deltas) a base reference, then a
//             zlib stream. Type codes: 1 commit, 2 tree, 3 blob, 4 tag,
//             6 OFS_DELTA, 7 REF_DELTA.
//   pkt-line  4 hex length digits (payload + 4) + payload; 0000 flush,
//             0001 delim, 0002 response-end.
//   sideband  each pkt-line payload starts with a band byte: 1 pack data,
//             2 progress, 3 error. A sideband packet is at most 65,520 bytes.

import { deflateSync, inflateSync } from 'node:zlib';
import { objectSha, type GitObjectType } from './gitobj.ts';
import { sha1 } from './util.ts';

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

export interface PackObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- pkt-line decoding

export type PktPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the start of `buffer`. Returns the packets and the
 * byte offset just past the last complete packet. Throws PackError on a
 * malformed header or a truncated packet. `stopAtFlush` stops after the
 * first flush packet (receive-pack: everything after it is the raw pack).
 */
export function decodePktLines(buffer: Buffer, stopAtFlush = false): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PackError(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new PackError(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new PackError('invalid pkt-line length 0003');
    if (length > 65_520) throw new PackError(`pkt-line length ${length} exceeds 65520`);
    if (offset + length > buffer.length) {
      throw new PackError(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The text of every data packet, in order (control packets dropped). */
export function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- delta application

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    if (offset >= buffer.length) throw new PackError('delta size varint is truncated');
    const byte = buffer[offset] as number;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new PackError('delta size varint is too long');
  }
  return { value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readVarint(delta, offset);
  offset = source.next;
  const target = readVarint(delta, offset);
  offset = target.next;
  if (source.value !== base.length) {
    throw new PackError(`delta expects a ${source.value}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new PackError('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new PackError('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new PackError('delta copy is out of the base');
      if (written + copySize > target.value) throw new PackError('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new PackError('delta insert is truncated');
      if (written + literal > target.value) throw new PackError('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new PackError('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new PackError(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

// ---------------------------------------------------------------- packfile reading

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

function readEntrySize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new PackError('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new PackError('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new PackError('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  let inflated: Buffer;
  let bytesWritten: number;
  try {
    const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    inflated = result.buffer;
    bytesWritten = result.engine.bytesWritten;
  } catch (err) {
    throw new PackError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  if (!bytesWritten || bytesWritten <= 0) throw new PackError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: inflated, next: offset + bytesWritten };
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, PackObject>;
  deltaCount: number;
  byteLength: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
 * leaves out (the reader already has it). Every object's SHA-1 is recomputed
 * from its resolved bytes; a mismatch is an error.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => PackObject | undefined } = {}): PackReadResult {
  if (pack.length < 32) throw new PackError(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = sha1(pack.subarray(0, trailerStart));
  if (trailer !== computedTrailer) {
    throw new PackError(`pack trailer ${trailer} does not match the bytes ${computedTrailer}`);
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntrySize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new PackError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new PackError(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new PackError(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new PackError(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, PackObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new PackError(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new PackError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new PackError(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = objectSha(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount, byteLength: pack.length };
}

// ---------------------------------------------------------------- packfile writing

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a version-2 packfile from plain objects (no deltas, so every object
 * is self-contained). The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

// ---------------------------------------------------------------- sideband framing

/** The largest pack-data payload one sideband pkt-line may carry. */
export const SIDEBAND_MAX_DATA = 65_520 - 4 - 1;

/**
 * Wrap `payload` in sideband band-`band` pkt-lines (each at most 65,520 bytes
 * on the wire). Band 1 is data, 2 progress, 3 error.
 */
export function sidebandWrap(payload: Buffer, band: 1 | 2 | 3): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  if (payload.length === 0) {
    // An empty payload still needs one packet so the section is not empty.
    const body = Buffer.from([band]);
    const len = (body.length + 4).toString(16).padStart(4, '0');
    parts.push(Buffer.concat([Buffer.from(len, 'ascii'), body]));
    return Buffer.concat(parts);
  }
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, offset + SIDEBAND_MAX_DATA);
    const body = Buffer.concat([Buffer.from([band]), chunk]);
    const len = (body.length + 4).toString(16).padStart(4, '0');
    parts.push(Buffer.concat([Buffer.from(len, 'ascii'), body]));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}
