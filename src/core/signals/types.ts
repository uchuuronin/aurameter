/**
 * SignalExtractor : the contract every signal must implement.
 *
 * Each of the four signals (Tea, Time, Clown, Slop) is an independent extractor.
 * They share input shape (the post), output shape (a SignalResult), and lifecycle
 * (call extract, get a score with reasons and confidence).
 *
 * This independence is the architecture decision that lets mods toggle any signal
 * off without breaking the rest, and lets us add a fifth signal post-hackathon
 * without refactoring the pipeline.
 */

import type { SubConfig } from '../config/types.js';

/**
 * The minimum post information any extractor needs.
 *
 * We deliberately do NOT pass the full Reddit Post object here. Extractors should
 * not call the Reddit API or touch user-level fields. Keeping this lean enforces
 * the reputation-free design rule.
 */
export interface PostInput {
  postId: string;
  subreddit: string;
  title: string;
  body: string;
}

/**
 * What an extractor returns. Note that `reasons` is human-readable and surfaces
 * in the mod dashboard's per-post drilldown and in the public flair tooltip.
 * Without reasons the tool feels like a black box; with reasons it feels like
 * moderation infrastructure.
 */
export interface SignalResult {
  /** Raw score, range depends on signal (see each extractor). */
  score: number;
  /** Plain-English explanations for what triggered this score. Cap at 5. */
  reasons: string[];
  /** Confidence in the score. Surfaces in the tooltip. */
  confidence: 'low' | 'medium' | 'high';
  /**
   * Raw feature values, for the mod dashboard's debug view and for per-sub
   * calibration. Not exposed publicly.
   */
  rawFeatures: Record<string, number>;
}

export type SignalName = 'tea' | 'time' | 'clown' | 'slop';

export interface SignalExtractor {
  /** Unique signal name. Used for storage keys and config lookups. */
  readonly name: SignalName;
  /**
   * The emoji used in flair text. Repeated `score` times in the flair string,
   * with the cap rules in engine/flair.ts.
   */
  readonly emoji: string;
  /** Maximum score this signal can produce. Tea caps at 5, others at 3. */
  readonly maxScore: number;
  /**
   * Run the extractor against a post.
   *
   * MUST be pure: no Reddit API calls, no Redis reads, no async I/O. The pipeline
   * runs all four extractors inline in the onPostSubmit handler and needs them
   * to finish in tens of milliseconds. If you need cross-post state (e.g. per-sub
   * percentile baselines), accept it via subConfig.
   */
  extract(post: PostInput, subConfig: SubConfig): SignalResult;
}
