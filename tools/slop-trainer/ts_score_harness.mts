/**
 * parity harness — prints the 9 slop features + probability for stdin texts as JSON.
 * Used by tools/slop-trainer/test_parity.py to prove TS runtime features match
 * the Python trainer features. Run with: node --experimental-strip-types
 *
 * Reads a JSON array of {id, body} from argv[2] (a file path), prints
 * [{id, features:{...}, probability, score}] to stdout.
 */
import { readFileSync } from 'node:fs';
import { slopExtractor } from '../../src/core/signals/slop.ts';
import { SLOP_WEIGHTS, SLOP_DECISION_THRESHOLDS } from '../../src/core/signals/slop_weights.ts';
import { logistic, bucketScore } from '../../src/core/lib/text.ts';

const FEATURE_KEYS = [
  'invSentenceLengthVariance', 'fingerprintRate', 'hedgeRate', 'emDashRate',
  'oxfordRate', 'invTypeTokenRatio', 'invOpenerDiversity', 'invQuestionRate', 'profanityRate',
];

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const dummyConfig = { signals: { slop: { visibility: 'public' } } };

const out = inputs.map((row) => {
  const res = slopExtractor.extract(
    { postId: 't3_x', subreddit: 'test', title: '', body: row.body },
    dummyConfig,
  );
  const rf = res.rawFeatures;
  // Recompute the canonical feature vector the way the trainer reads it.
  // slop.ts stores raw feature components under these rawFeatures keys:
  //   invSentenceLengthVariance is NOT stored directly; derive from sentLenVariance.
  const invSentVar = 1 / (1 + (rf.sentLenVariance ?? 0) / 50);
  const invTtr = 1 - (rf.ttr ?? 0);
  const invOpenerDiv = 1 - (rf.openerDiversity ?? 1);
  const invQuestionRate = 1 / (1 + (rf.questionRate ?? 0) * 5);
  const features = {
    invSentenceLengthVariance: invSentVar,
    fingerprintRate: rf.fingerprintRate ?? 0,
    hedgeRate: rf.hedgeRate ?? 0,
    emDashRate: rf.emDashRate ?? 0,
    oxfordRate: rf.oxfordRate ?? 0,
    invTypeTokenRatio: invTtr,
    invOpenerDiversity: invOpenerDiv,
    invQuestionRate: invQuestionRate,
    profanityRate: rf.profanityRate ?? 0,
  };
  let linear = SLOP_WEIGHTS.bias;
  for (const k of FEATURE_KEYS) linear += SLOP_WEIGHTS[k] * features[k];
  const probability = logistic(linear);
  const score = bucketScore(probability, [...SLOP_DECISION_THRESHOLDS]);
  return { id: row.id, features, probability, score, skipped: rf.skipped === 1 };
});

console.log(JSON.stringify(out));
