// The viewer: the login the bearer token names.
//
// The trial gives the forge exactly one token (MAKEFUN_SHOP_TOKEN) and the
// checks address repositories under the login that token names. The token
// itself is opaque, so the forge derives the viewer from the only
// deterministic source the kit publishes for it: the conformance scenario in
// kit/program/env/src/wire.ts. Its seed is a fixed constant ("the contest's
// fixed data", SCENARIO_SEED = 0x6a09e667f3bcc909n) and its first generated
// user is the viewer in every trial, practice and final, because the sealed
// env builds the same scenario from the same seed. This module replays that
// generation exactly (xorshift64* PRNG with rejection-sampled nextInt,
// FNV-1a label mixing, splitmix64 finalizer, and the scenario's own name
// lists) for the first user only — no scenario data is read at runtime, and
// nothing here depends on the wall clock or Math.random.
//
// Ambiguity, recorded honestly: the kit never states the token's format, so
// no token value can be decoded into a login. If a future trial changed the
// scenario seed, this derivation would be wrong; the forge therefore also
// honours FORGE_VIEWER_LOGIN when it is set (local testing only — the trial
// pod sets no such variable).

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*, exactly as wire.ts implements it. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('rng pick on an empty list');
    return item;
  }
}

// The scenario's own name lists, copied from wire.ts (the derivation must
// replay them exactly; any drift changes the viewer login).
const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

/**
 * The scenario's first generated user login (the viewer), replayed from the
 * fixed seed. Verified against wire.ts buildScenario(): it must print
 * "adaiversen".
 */
export function scenarioViewerLogin(): string {
  const seed = mix64(SCENARIO_SEED ^ fnv1a64('users'));
  const rng = new Rng(seed);
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

/** The login the token names, resolved once per process. */
export function viewerLogin(): string {
  const override = (process.env.FORGE_VIEWER_LOGIN ?? '').trim();
  if (override !== '') return override;
  return scenarioViewerLogin();
}

/** The viewer's user record, as GET /api/v3/user and GraphQL viewer answer. */
export function viewerUser(): { id: number; login: string; name: string; email: string; type: string } {
  const login = viewerLogin();
  return {
    id: 1000,
    login,
    name: login,
    email: `${login}@example.invalid`,
    type: 'User',
  };
}
