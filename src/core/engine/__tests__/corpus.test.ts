// src/core/engine/__tests__/corpus.test.ts
//
// Block 2 corpus tests.
//   Task 1: wasQueuedOnSlop purity predicate (pure).
//   Task 2: appendCorpusEntry/readCorpus round-trip, toCorpusJsonl, appendVerdict purity skip.
//   Task 3: saveSlopFeatures/loadSlopFeatures round-trip.
//   Task 4: classifyModAction (pure).
//
// Redis-touching tests run against the in-memory fake aliased in vitest.config.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  wasQueuedOnSlop,
  classifyModAction,
  toCorpusJsonl,
  appendCorpusEntry,
  readCorpus,
  appendVerdict,
  corpusSize,
  isRetrainDue,
  loadLastRetrainAt,
  markRetrained,
  MIN_RETRAIN_CORPUS,
  RETRAIN_INTERVAL_MS,
  type QueueReason,
  type CorpusEntry,
} from '../corpus.js';
import {
  recordQueueReason,
  saveSlopFeatures,
  loadSlopFeatures,
} from '../storage.js';
import { __resetRedis } from '../../../../test/devvit-server-mock.js';

beforeEach(() => {
  __resetRedis();
});

// ── Task 1: wasQueuedOnSlop ───────────────────────────────────────────────────

describe('wasQueuedOnSlop', () => {
  it('true when a fired rule has a slop>=2 condition', () => {
    const reason: QueueReason = {
      ruleId: 'auto-slop-queue',
      conditions: [{ signal: 'slop', comparator: '>=', threshold: 2 }],
    };
    expect(wasQueuedOnSlop(reason)).toBe(true);
  });

  it('false when fired rule is tea-only', () => {
    const reason: QueueReason = {
      ruleId: 'tea-rule',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 4 }],
    };
    expect(wasQueuedOnSlop(reason)).toBe(false);
  });

  it('false for null reason', () => {
    expect(wasQueuedOnSlop(null)).toBe(false);
  });

  it('true when slop is among multiple merged conditions', () => {
    const reason: QueueReason = {
      ruleId: 'tea-rule',
      conditions: [
        { signal: 'tea', comparator: '>=', threshold: 4 },
        { signal: 'slop', comparator: '>=', threshold: 3 },
      ],
    };
    expect(wasQueuedOnSlop(reason)).toBe(true);
  });

  it('false for slop<=1 (queued because slop was LOW)', () => {
    const reason: QueueReason = {
      ruleId: 'x',
      conditions: [{ signal: 'slop', comparator: '<=', threshold: 1 }],
    };
    expect(wasQueuedOnSlop(reason)).toBe(false);
  });

  it('false for slop>=1 (below the purity floor of 2)', () => {
    const reason: QueueReason = {
      ruleId: 'x',
      conditions: [{ signal: 'slop', comparator: '>=', threshold: 1 }],
    };
    expect(wasQueuedOnSlop(reason)).toBe(false);
  });
});

// ── Task 4: classifyModAction ─────────────────────────────────────────────────

describe('classifyModAction', () => {
  it('removelink and spamlink are ai-positive', () => {
    expect(classifyModAction('removelink')).toBe('ai-positive');
    expect(classifyModAction('spamlink')).toBe('ai-positive');
  });

  it('approvelink is non-ai-negative', () => {
    expect(classifyModAction('approvelink')).toBe('non-ai-negative');
  });

  it('everything else is ignore', () => {
    expect(classifyModAction('distinguish')).toBe('ignore');
    expect(classifyModAction('removecomment')).toBe('ignore');
    expect(classifyModAction('')).toBe('ignore');
    expect(classifyModAction(null)).toBe('ignore');
    expect(classifyModAction(undefined)).toBe('ignore');
  });

  it('is case-insensitive', () => {
    expect(classifyModAction('RemoveLink')).toBe('ai-positive');
    expect(classifyModAction('APPROVELINK')).toBe('non-ai-negative');
  });
});

// ── Task 2: toCorpusJsonl (pure) ──────────────────────────────────────────────

describe('toCorpusJsonl', () => {
  it('emits one JSON object per line', () => {
    const entries: CorpusEntry[] = [
      { id: 'c1', ts: 1000, features: { fingerprintRate: 1.2 }, label: 1, source: 'passive' },
      { id: 'c2', ts: 2000, features: { hedgeRate: 0 }, label: 0, source: 'spotcheck' },
    ];
    const jsonl = toCorpusJsonl(entries);
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(entries[0]);
    expect(JSON.parse(lines[1]!)).toEqual(entries[1]);
  });

  it('emits empty string for no entries', () => {
    expect(toCorpusJsonl([])).toBe('');
  });
});

// ── Task 2: appendCorpusEntry + readCorpus round-trip ─────────────────────────

describe('appendCorpusEntry + readCorpus', () => {
  it('appended entry is read back', async () => {
    const entry: CorpusEntry = {
      id: 'c1', ts: 1000, features: { fingerprintRate: 1.2 }, label: 1, source: 'passive',
    };
    await appendCorpusEntry(entry);
    const got = await readCorpus({ limit: 10 });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(entry);
  });

  it('reads newest-first', async () => {
    await appendCorpusEntry({ id: 'old', ts: 1000, features: {}, label: 0, source: 'passive' });
    await appendCorpusEntry({ id: 'new', ts: 2000, features: {}, label: 1, source: 'passive' });
    const got = await readCorpus({ limit: 10 });
    expect(got.map((e) => e.id)).toEqual(['new', 'old']);
  });
});

// ── Task 3: saveSlopFeatures + loadSlopFeatures round-trip ────────────────────

describe('saveSlopFeatures + loadSlopFeatures', () => {
  it('round-trips a feature vector', async () => {
    const features = { sentLenVariance: 42.3, fingerprintRate: 1.67, probability: 0.41 };
    await saveSlopFeatures('t3_abc', features);
    const got = await loadSlopFeatures('t3_abc');
    expect(got).toEqual(features);
  });

  it('returns null for an unknown post', async () => {
    expect(await loadSlopFeatures('t3_nope')).toBeNull();
  });
});

// ── Task 2/4: appendVerdict purity gate ───────────────────────────────────────

describe('appendVerdict purity gate', () => {
  const features = { sentLenVariance: 10, probability: 0.8 };

  it('passive verdict appends when post was slop-queued AND has features', async () => {
    await recordQueueReason('t3_slop', {
      ruleId: 'auto-slop-queue',
      conditions: [{ signal: 'slop', comparator: '>=', threshold: 2 }],
    });
    await saveSlopFeatures('t3_slop', features);

    const appended = await appendVerdict({ postId: 't3_slop', label: 1, source: 'passive' });
    expect(appended).toBe(true);
    const corpus = await readCorpus({ limit: 10 });
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.features).toEqual(features);
    expect(corpus[0]!.label).toBe(1);
  });

  it('passive verdict SKIPS when post was queued on tea only (purity)', async () => {
    await recordQueueReason('t3_tea', {
      ruleId: 'tea-rule',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 4 }],
    });
    await saveSlopFeatures('t3_tea', features);

    const appended = await appendVerdict({ postId: 't3_tea', label: 1, source: 'passive' });
    expect(appended).toBe(false);
    expect(await readCorpus({ limit: 10 })).toHaveLength(0);
  });

  it('passive verdict SKIPS when there is no queue reason at all', async () => {
    await saveSlopFeatures('t3_noreason', features);
    const appended = await appendVerdict({ postId: 't3_noreason', label: 1, source: 'passive' });
    expect(appended).toBe(false);
  });

  it('passive verdict SKIPS when the post has no stored features', async () => {
    await recordQueueReason('t3_nofeat', {
      ruleId: 'auto-slop-queue',
      conditions: [{ signal: 'slop', comparator: '>=', threshold: 2 }],
    });
    const appended = await appendVerdict({ postId: 't3_nofeat', label: 1, source: 'passive' });
    expect(appended).toBe(false);
  });

  it('spotcheck verdict BYPASSES purity (no slop queue reason needed)', async () => {
    // tea-only queue reason; spotcheck should still append.
    await recordQueueReason('t3_sc', {
      ruleId: 'tea-rule',
      conditions: [{ signal: 'tea', comparator: '>=', threshold: 4 }],
    });
    await saveSlopFeatures('t3_sc', features);

    const appended = await appendVerdict({ postId: 't3_sc', label: 0, source: 'spotcheck' });
    expect(appended).toBe(true);
    const corpus = await readCorpus({ limit: 10 });
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.source).toBe('spotcheck');
    expect(corpus[0]!.label).toBe(0);
  });

  it('spotcheck verdict STILL SKIPS when there are no features', async () => {
    const appended = await appendVerdict({ postId: 't3_scnofeat', label: 0, source: 'spotcheck' });
    expect(appended).toBe(false);
  });
});

// ── Task 9: retrain readiness ─────────────────────────────────────────────────

describe('isRetrainDue (pure)', () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it('true when corpus is big enough AND never retrained', () => {
    expect(isRetrainDue(MIN_RETRAIN_CORPUS, 0, now)).toBe(true);
    expect(isRetrainDue(MIN_RETRAIN_CORPUS + 100, 0, now)).toBe(true);
  });

  it('false when corpus is too small, however long ago', () => {
    expect(isRetrainDue(MIN_RETRAIN_CORPUS - 1, 0, now)).toBe(false);
  });

  it('false when retrained recently, however big', () => {
    expect(isRetrainDue(MIN_RETRAIN_CORPUS + 1000, now - day, now)).toBe(false);
  });

  it('true when big AND last retrain older than the interval', () => {
    expect(isRetrainDue(MIN_RETRAIN_CORPUS, now - (RETRAIN_INTERVAL_MS + day), now)).toBe(true);
  });

  it('false exactly at the interval (strictly greater required)', () => {
    expect(isRetrainDue(MIN_RETRAIN_CORPUS, now - RETRAIN_INTERVAL_MS, now)).toBe(false);
  });
});

describe('retrain marker round-trip', () => {
  it('defaults to 0 when never recorded', async () => {
    expect(await loadLastRetrainAt()).toBe(0);
  });

  it('records and reads back a timestamp', async () => {
    await markRetrained(12345);
    expect(await loadLastRetrainAt()).toBe(12345);
  });

  it('corpusSize reflects appended entries', async () => {
    expect(await corpusSize()).toBe(0);
    await appendCorpusEntry({ id: 'a', ts: 1, features: {}, label: 0, source: 'passive' });
    await appendCorpusEntry({ id: 'b', ts: 2, features: {}, label: 1, source: 'passive' });
    expect(await corpusSize()).toBe(2);
  });
});
