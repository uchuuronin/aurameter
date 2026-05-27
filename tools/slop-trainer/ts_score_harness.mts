/**
 * parity harness — prints the 9 slop features + probability for stdin texts as JSON.
 * Used by tools/slop-trainer/test_parity.py to prove TS runtime features match
 * the Python trainer features. Run with: node --experimental-strip-types
 *
 * Reads a JSON array of {id, body} from argv[2] (a file path), prints
 * [{id, features:{...}, probability, score}] to stdout.
 *
 * The canonical feature vector is computed by slopFeatureVector() in slop.ts —
 * the SINGLE SOURCE OF TRUTH for the runtime↔trainer feature contract (Block 2,
 * Path A). This harness routing through that function is what lets test_parity.py
 * guard the exact transform the corpus-persistence path also uses; if the
 * transform ever drifts, parity fails here.
 */
import { readFileSync } from 'node:fs';
import { slopExtractor, slopFeatureVector, SLOP_FEATURE_KEYS } from '../../src/core/signals/slop.ts';
import { SLOP_WEIGHTS, SLOP_DECISION_THRESHOLDS } from '../../src/core/signals/slop_weights.ts';
import { logistic, bucketScore } from '../../src/core/lib/text.ts';

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const dummyConfig = { signals: { slop: { visibility: 'public' } } };

const out = inputs.map((row) => {
  const res = slopExtractor.extract(
    { postId: 't3_x', subreddit: 'test', title: '', body: row.body },
    dummyConfig,
  );
  // Canonical feature vector via the SINGLE SOURCE OF TRUTH in slop.ts.
  const features = slopFeatureVector(res.rawFeatures);
  let linear = SLOP_WEIGHTS.bias;
  for (const k of SLOP_FEATURE_KEYS) linear += SLOP_WEIGHTS[k] * features[k];
  const probability = logistic(linear);
  const score = bucketScore(probability, [...SLOP_DECISION_THRESHOLDS]);
  return { id: row.id, features, probability, score, skipped: res.rawFeatures.skipped === 1 };
});

console.log(JSON.stringify(out));
