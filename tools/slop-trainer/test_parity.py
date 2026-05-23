#!/usr/bin/env python3
"""
aurameter slop-trainer :: test_parity.py

Proves the Python trainer (features.py) and the TypeScript runtime (slop.ts)
compute the SAME features on the SAME text. If this drifts, the fitted weights
are calibrated to inputs the runtime never produces, and the classifier is
silently wrong. This test is the contract enforcer.

It:
  1. Builds a handful of probe texts spanning the feature axes.
  2. Computes features in Python via features.py.
  3. Computes features in TS via ts_score_harness.mts (node strips types).
  4. Asserts each feature matches within a tight tolerance.

Run: python3 test_parity.py
Exit 0 = parity holds. Exit 1 = drift detected (DO NOT trust the weights).
"""

import json
import os
import subprocess
import sys
import tempfile

from features import extract_features, FEATURE_KEYS, logistic, score_with_weights

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "ts_score_harness.mts")
WEIGHTS_TS = os.path.abspath(os.path.join(HERE, "..", "..", "src", "core", "signals", "slop_weights.ts"))

TOL = 1e-9

PROBES = [
    {"id": "human_swearing",
     "body": ("So this happened and honestly what the hell? My sister showed up uninvited "
              "and screamed at me. I told her to leave. She refused. Am I the asshole here? "
              "I work two jobs and I'm exhausted, damn it. Tell me I'm not crazy.")},
    {"id": "llm_smooth",
     "body": ("It's important to note that family dynamics can be quite nuanced. On the other "
              "hand, one might consider the perspective of the other party. Furthermore, "
              "navigating the complexities of these relationships is paramount. Generally "
              "speaking, communication tends to be the foundation of resolution. In conclusion, "
              "approaching the situation with empathy may prove beneficial.")},
    {"id": "mixed_medium",
     "body": ("My mom called me selfish. Perhaps she has a point, but I delve into this often. "
              "We argued about money. It depends on how you look at it, I guess. Furthermore I "
              "was tired and snapped at her. Was that wrong of me to do in that moment?")},
    {"id": "too_short",
     "body": "Short post. Not enough words here."},
]


def parse_weights_ts():
    """Read the generated slop_weights.ts to mirror exact runtime scoring."""
    txt = open(WEIGHTS_TS).read()
    import re
    block = re.search(r"SLOP_WEIGHTS\s*=\s*\{(.*?)\}\s*as const;", txt, re.DOTALL).group(1)
    weights = {}
    for m in re.finditer(r"(\w+):\s*(-?[\d.]+)", block):
        weights[m.group(1)] = float(m.group(2))
    th = re.search(r"SLOP_DECISION_THRESHOLDS[^=]*=\s*\[([^\]]+)\]", txt).group(1)
    thresholds = [float(x) for x in th.split(",")]
    return weights, thresholds


def run_ts_harness():
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        json.dump(PROBES, tf)
        probe_path = tf.name
    try:
        # Node 22 strips TS types natively for .mts via --experimental-strip-types.
        bundled = os.path.join(HERE, "_harness_bundled.mjs")
        if not os.path.exists(bundled):
            print("[parity] bundle missing; run build_harness.sh first", file=sys.stderr)
            sys.exit(1)
        res = subprocess.run(
            ["node", bundled, probe_path],
            capture_output=True, text=True, cwd=HERE,
        )
        if res.returncode != 0:
            print("[parity] TS harness failed:\n" + res.stderr, file=sys.stderr)
            sys.exit(1)
        # Node may print strip-types warnings to stderr; stdout is the JSON.
        return json.loads(res.stdout.strip().splitlines()[-1])
    finally:
        os.unlink(probe_path)


def main():
    weights, thresholds = parse_weights_ts()
    ts_results = {r["id"]: r for r in run_ts_harness()}

    failures = []
    for probe in PROBES:
        pid = probe["id"]
        feats, skip = extract_features(probe["body"])
        ts = ts_results.get(pid)
        if ts is None:
            failures.append(f"{pid}: missing from TS output")
            continue

        if skip is not None:
            # Python skipped; TS must also skip.
            if not ts.get("skipped"):
                failures.append(f"{pid}: Python skipped ({skip}) but TS did not")
            else:
                print(f"[parity] {pid}: both skipped ({skip}) ✓")
            continue

        if ts.get("skipped"):
            failures.append(f"{pid}: TS skipped but Python did not")
            continue

        # Compare each feature.
        for k in FEATURE_KEYS:
            pv = feats[k]
            tv = ts["features"][k]
            if abs(pv - tv) > TOL:
                failures.append(f"{pid}.{k}: python={pv:.12f} ts={tv:.12f} (Δ={abs(pv-tv):.2e})")

        # Compare end-to-end probability + score using the SAME weights.
        prob_py, score_py = score_with_weights(probe["body"], weights)
        if prob_py is not None:
            if abs(prob_py - ts["probability"]) > 1e-7:
                failures.append(f"{pid}.probability: python={prob_py:.9f} ts={ts['probability']:.9f}")
            if score_py != ts["score"]:
                failures.append(f"{pid}.score: python={score_py} ts={ts['score']}")
        if not failures or all(pid not in f for f in failures):
            print(f"[parity] {pid}: features+probability+score match ✓")

    if failures:
        print("\n[parity] ❌ DRIFT DETECTED:")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("\n[parity] ✅ Python trainer and TS runtime compute identical features. Weights are valid.")


if __name__ == "__main__":
    main()
