// Shared deterministic helpers for the forge. No wall clock and no unseeded
// randomness anywhere in request handling: timestamps come from the trial's
// MAKEFUN_TRIAL_NOW (or a fixed epoch when the trial does not set one), ids
// and SHAs are content-addressed, and the request id is a monotonic counter.

import { createHash } from 'node:crypto';

/** The fixed epoch used when MAKEFUN_TRIAL_NOW is unset (local runs). */
export const FIXED_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

/**
 * The trial's "now", read once at module load: the env sets
 * MAKEFUN_TRIAL_NOW before the process starts and nothing in the server
 * ever changes it, so the value is constant for the process lifetime.
 * (Same reasoning as the cached bearer token in http.ts.) This keeps
 * every timestamp call site — issue/pull/comment creation, commit
 * timestamps — from re-reading process.env and re-formatting a Date.
 */
function resolveTrialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Number(raw);
  if (raw !== '' && Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return FIXED_EPOCH_SEC;
}
const TRIAL_NOW_SEC = resolveTrialNowSec();
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_SEC * 1000).toISOString();

/** The trial's "now" in epoch seconds, from MAKEFUN_TRIAL_NOW when set. */
export function trialNowSec(): number {
  return TRIAL_NOW_SEC;
}

/** An ISO-8601 timestamp for the trial's now. */
export function trialNowIso(): string {
  return TRIAL_NOW_ISO;
}

/** SHA-1 of a Buffer, lowercase hex (git object ids). */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 of a UTF-8 string. */
export function sha1Text(text: string): string {
  return sha1(Buffer.from(text, 'utf8'));
}

/** Base64 of a Buffer (GitHub contents API encoding). */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

/** Decode base64, or null when the input is not valid base64. */
export function b64decode(text: string): Buffer | null {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) return null;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

/** A 40-hex SHA test (git object ids and content SHAs). */
export function isSha40(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** A monotonic, process-local request counter for X-GitHub-Request-Id. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Escape a string for safe inclusion in a JSON error message (defensive). */
export function safeText(value: unknown, maxLen = 200): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** Split a path into segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** A deterministic integer id from a seed string (repo/issue node ids). */
export function deterministicId(seed: string, base: number): number {
  const digest = sha1Text(seed);
  const value = Number.parseInt(digest.slice(0, 8), 16);
  return base + (value % 100_000_000);
}

/** A stable opaque node id for a GraphQL/REST object (R/I/PR/C/IC/U + hash). */
export function nodeId(kind: string, seed: string): string {
  return `${kind}_${sha1Text(seed).slice(0, 20)}`;
}
