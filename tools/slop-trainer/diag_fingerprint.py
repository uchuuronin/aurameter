#!/usr/bin/env python3
"""
diag_fingerprint2.py — compute fingerprintRate per class by re-extracting
features straight from the corpus .txt files (no registry needed).

Run from tools/slop-trainer/ :  python diag_fingerprint2.py

It first prints the folder layout it sees, then for every .txt under the
human and llm corpus dirs it runs extract_features() and reports the
fingerprintRate distribution per class plus a verdict.
"""
import os, glob, statistics as s
from features import extract_features

# --- discover layout ---
print("=" * 70)
print("Corpus layout under ./corpus :")
for root, dirs, files in os.walk("corpus"):
    txts = [f for f in files if f.endswith(".txt")]
    if txts or dirs:
        print(f"  {root}/   ({len(txts)} .txt files)")

# candidate class dirs — try the obvious ones, fall back to anything found
HUMAN_DIRS = [d for d in ("corpus/human", "corpus/scraped", "corpus/reddit") if os.path.isdir(d)]
LLM_DIRS   = [d for d in ("corpus/llm", "corpus/synthetic", "corpus/generated") if os.path.isdir(d)]

print("\nUsing human dirs:", HUMAN_DIRS or "(none found!)")
print("Using llm dirs:  ", LLM_DIRS or "(none found!)")
if not HUMAN_DIRS or not LLM_DIRS:
    print("\n!! Could not find expected class folders. The layout above shows what exists —")
    print("   tell me which folders hold human vs llm .txt files and I'll adjust.")
    raise SystemExit

def collect(dirs):
    vals, n_used, n_skip = [], 0, 0
    for d in dirs:
        for path in glob.glob(os.path.join(d, "*.txt")):
            try:
                body = open(path, encoding="utf-8").read()
            except UnicodeDecodeError:
                body = open(path, encoding="utf-8", errors="ignore").read()
            feats, skip = extract_features(body)
            if feats is None:
                n_skip += 1
                continue
            vals.append(feats["fingerprintRate"])
            n_used += 1
    return vals, n_used, n_skip

human, hu_used, hu_skip = collect(HUMAN_DIRS)
llm,   ll_used, ll_skip = collect(LLM_DIRS)

print("\n" + "=" * 70)
print("fingerprintRate by class (re-extracted from .txt)")
def show(name, v, used, skip):
    if v:
        print(f"  {name:6} n={used:4d} (skipped {skip})  mean={s.mean(v):.3f}  "
              f"median={s.median(v):.3f}  max={max(v):.3f}  "
              f"nonzero={sum(1 for x in v if x>0)}/{len(v)}")
    else:
        print(f"  {name:6} n=0 used; skipped {skip}")
show("human", human, hu_used, hu_skip)
show("llm",   llm,   ll_used, ll_skip)

print("\n" + "=" * 70)
if human and llm:
    if s.mean(llm) > s.mean(human):
        print("VERDICT: LLM mean > human mean  ->  signal points the RIGHT way.")
        print("         Negative exported weight = un-standardization artifact. Fix is in fit.py.")
    else:
        print("VERDICT: human mean >= LLM mean  ->  CORPUS SKEW.")
        print("         Hand-written LLM posts scrubbed the fingerprint tells.")
        print("         No fit.py change fixes this; corpus or feature set must change.")