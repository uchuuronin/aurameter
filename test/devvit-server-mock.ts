/**
 * In-memory Redis fake for unit tests.
 *
 * The real runtime gets `redis` from `@devvit/web/server`, which only works
 * inside a Devvit server process. Our redis-touching modules (storage.ts,
 * corpus.ts, spotcheck.ts) import it at module load, so any test that imports
 * them needs a stand-in. This implements exactly the surface those modules use,
 * with Devvit/Redis-compatible semantics:
 *
 *   hashes:      hSet / hGet / hGetAll / del
 *   strings:     get / set / del / expire
 *   sorted sets: zAdd / zRange (by:'score'|'rank', reverse) / zRem /
 *                zRemRangeByRank / zRemRangeByScore
 *
 * RANK SEMANTICS (the subtle part — got this wrong twice, documenting it):
 *  - start/stop for zRange and zRemRangeByRank are 0-based RANK indices, NOT
 *    score bounds. `by:'score'` only chooses the ORDERING; the indices are
 *    still ranks. (Production code relies on `(0, -1)` returning ALL members.)
 *  - Negative indices count from the end: -1 = last, -2 = second-last.
 *  - Resolution (matches real Redis ZRANGE/ZREMRANGEBYRANK):
 *      • resolve negative: idx < 0  ->  idx + n
 *      • START: if still < 0, clamp UP to 0
 *      • STOP:  if still < 0 (underflowed past the start), the range is EMPTY
 *               — do NOT clamp up to 0. This is what makes a trim like
 *               zRemRangeByRank(key, 0, -(CAP+1)) a no-op when there are fewer
 *               than CAP+1 members (instead of wrongly deleting member 0).
 *      • STOP: if >= n, clamp down to n-1.
 *      • if resolved start > resolved stop, the range is EMPTY.
 *
 * Test-only. Wired in via vitest.config.ts `test.alias` so
 * `import { redis } from '@devvit/web/server'` resolves here under Vitest only.
 */

interface ZMember {
  member: string;
  score: number;
}

/**
 * Resolve a Redis rank range [start, stop] (inclusive, negatives-from-end) to a
 * concrete [lo, hi] slice, or null when the range is empty. See the RANK
 * SEMANTICS note above — the asymmetry between start (clamp up to 0) and stop
 * (underflow => empty) is the whole point.
 */
function resolveRankRange(n: number, start: number, stop: number): [number, number] | null {
  if (n === 0) return null;
  let lo = start < 0 ? start + n : start;
  let hi = stop < 0 ? stop + n : stop;
  if (lo < 0) lo = 0; // start clamps up to 0
  if (hi < 0) return null; // stop underflowed past the beginning -> empty range
  if (hi >= n) hi = n - 1; // stop clamps down to last
  if (lo > hi) return null;
  return [lo, hi];
}

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, string>();
  private zsets = new Map<string, ZMember[]>();
  private ttls = new Map<string, number>();

  /** Test helper: wipe everything between tests. */
  __reset(): void {
    this.hashes.clear();
    this.strings.clear();
    this.zsets.clear();
    this.ttls.clear();
  }

  // ── hashes ──────────────────────────────────────────────────────────────
  async hSet(key: string, fields: Record<string, string>): Promise<number> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    let added = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (!h.has(k)) added++;
      h.set(k, String(v));
    }
    return added;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }

  // ── strings ─────────────────────────────────────────────────────────────
  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.strings.set(key, String(value));
  }

  // ── generic ─────────────────────────────────────────────────────────────
  async del(key: string): Promise<void> {
    this.hashes.delete(key);
    this.strings.delete(key);
    this.zsets.delete(key);
    this.ttls.delete(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, seconds);
  }

  /** Test helper: read back a recorded TTL (seconds), or undefined. */
  __ttl(key: string): number | undefined {
    return this.ttls.get(key);
  }

  // ── sorted sets ───────────────────────────────────────────────────────────
  async zAdd(key: string, ...members: ZMember[]): Promise<number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = [];
      this.zsets.set(key, z);
    }
    let added = 0;
    for (const m of members) {
      const existing = z.find((e) => e.member === m.member);
      if (existing) {
        existing.score = m.score;
      } else {
        z.push({ member: m.member, score: m.score });
        added++;
      }
    }
    return added;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const z = this.zsets.get(key);
    if (!z) return 0;
    let removed = 0;
    for (const m of members) {
      const i = z.findIndex((e) => e.member === m);
      if (i >= 0) {
        z.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    opts?: { by?: 'score' | 'rank'; reverse?: boolean },
  ): Promise<ZMember[]> {
    const z = this.zsets.get(key);
    if (!z || z.length === 0) return [];
    const reverse = opts?.reverse ?? false;

    // start/stop are ALWAYS rank indices; `by` only selects the ordering (our
    // members are scored, so score-order and rank-order coincide). reverse
    // flips the ordering BEFORE the rank slice is taken.
    const asc = [...z].sort((a, b) => a.score - b.score);
    const ordered = reverse ? asc.reverse() : asc;

    const range = resolveRankRange(ordered.length, start, stop);
    if (!range) return [];
    return ordered.slice(range[0], range[1] + 1);
  }

  async zRemRangeByRank(key: string, start: number, stop: number): Promise<number> {
    const z = this.zsets.get(key);
    if (!z || z.length === 0) return 0;
    const asc = [...z].sort((a, b) => a.score - b.score);
    const range = resolveRankRange(asc.length, start, stop);
    if (!range) return 0;
    const toRemove = new Set(asc.slice(range[0], range[1] + 1).map((e) => e.member));
    const kept = z.filter((e) => !toRemove.has(e.member));
    this.zsets.set(key, kept);
    return toRemove.size;
  }

  async zRemRangeByScore(key: string, min: number, max: number): Promise<number> {
    const z = this.zsets.get(key);
    if (!z || z.length === 0) return 0;
    const kept = z.filter((e) => !(e.score >= min && e.score <= max));
    const removed = z.length - kept.length;
    this.zsets.set(key, kept);
    return removed;
  }
}

export const redis = new InMemoryRedis();

/** Test-only: reset the shared instance between tests. */
export function __resetRedis(): void {
  redis.__reset();
}
