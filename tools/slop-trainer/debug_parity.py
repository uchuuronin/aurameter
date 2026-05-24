#!/usr/bin/env python3
"""
debug_parity.py — localize the slop parity drift.

Writes nothing. Prints, for each probe:
  - the weights as parsed from slop_weights.ts
  - the python feature vector
  - the linear sum term-by-term (so we see which term dominates)
  - the resulting probability

Run from tools/slop-trainer/ :  python debug_parity.py
Paste the FULL output back.
"""
import re, os
from features import extract_features, FEATURE_KEYS, logistic

WEIGHTS_TS = os.path.abspath(os.path.join("..", "..", "src", "core", "signals", "slop_weights.ts"))

PROBES = {
    "human_swearing": ("So this happened and honestly what the hell? My sister showed up uninvited "
                       "and screamed at me. I told her to leave. She refused. Am I the asshole here? "
                       "I work two jobs and I'm exhausted, damn it. Tell me I'm not crazy."),
    "llm_smooth": ("It's important to note that family dynamics can be quite nuanced. On the other "
                   "hand, one might consider the perspective of the other party. Furthermore, "
                   "navigating the complexities of these relationships is paramount. Generally "
                   "speaking, communication tends to be the foundation of resolution. In conclusion, "
                   "approaching the situation with empathy may prove beneficial."),
    "mixed_medium": ("My mom called me selfish. Perhaps she has a point, but I delve into this often. "
                     "We argued about money. It depends on how you look at it, I guess. Furthermore I "
                     "was tired and snapped at her. Was that wrong of me to do in that moment?"),
}

# --- parse weights exactly as test_parity.py does ---
txt = open(WEIGHTS_TS, encoding="utf-8").read()
block = re.search(r"SLOP_WEIGHTS\s*=\s*\{(.*?)\}\s*as const;", txt, re.DOTALL).group(1)
W = {}
for m in re.finditer(r"(\w+):\s*(-?[\d.eE+-]+)", block):
    W[m.group(1)] = float(m.group(2))

thr = re.search(r"SLOP_DECISION_THRESHOLDS[^=]*=\s*\[([^\]]+)\]", txt).group(1)
thresholds = [float(x) for x in thr.split(",")]
mode = re.search(r'SLOP_MODE[^=]*=\s*"(\w+)"', txt)
mode = mode.group(1) if mode else "?"

print("=" * 70)
print(f"slop_weights.ts  MODE={mode}  THRESHOLDS={thresholds}")
print("=== WEIGHTS as parsed ===")
for k in (["bias"] + FEATURE_KEYS):
    print(f"  {k:32} {W.get(k)}")

for name, body in PROBES.items():
    print("\n" + "=" * 70)
    print(f"PROBE: {name}")
    feats, skip = extract_features(body)
    if feats is None:
        print(f"  skipped: {skip}")
        continue
    linear = W["bias"]
    print(f"  start bias = {W['bias']:+.4f}")
    for k in FEATURE_KEYS:
        term = W[k] * feats[k]
        linear += term
        print(f"  {k:30} w={W[k]:+9.4f} * x={feats[k]:9.4f} = {term:+9.4f}   running={linear:+9.4f}")
    p = logistic(linear)
    score = sum(1 for t in thresholds if p >= t)
    print(f"  >>> FINAL linear={linear:.6f}  probability={p:.9f}  score={score}")
