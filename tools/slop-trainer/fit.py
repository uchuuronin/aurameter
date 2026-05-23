#!/usr/bin/env python3
"""
aurameter slop-trainer :: fit.py

Reads corpus/manifest.csv, computes the 10 slop features per post (via
features.py, the exact port of slop.ts), fits a logistic regression in
scikit-learn, evaluates held-out AUC, and exports fitted coefficients to a
TypeScript constants file that slop.ts imports.

THE KILL THRESHOLD (project-plan.md 9.4 + risk register):
  If held-out AUC < 0.70, the classifier is not trustworthy as a "synthetic
  text" detector. We DO NOT ship low-AUC weights as if they were good. Instead
  we emit the weights but stamp mode="boilerplate" and a high decision
  threshold so slop.ts only fires on the top ~5% most-confident posts, and the
  public framing degrades from "synthetic-text likelihood" to "boilerplate /
  templated-text detector". This is the honest degraded path the plan calls
  for, not a silent failure.

USAGE:
  python3 fit.py                 # fit on corpus/manifest.csv, write weights
  python3 fit.py --dry-run       # fit + report metrics, don't write weights
  python3 fit.py --seed 7        # reproducible split

OUTPUT:
  ../../src/core/signals/slop_weights.ts   (the TS constants slop.ts imports)
  report.json                              (metrics + provenance for the README)
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, precision_score, recall_score

from features import feature_vector, FEATURE_KEYS

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
MANIFEST = os.path.join(CORPUS, "manifest.csv")
TS_OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "core", "signals", "slop_weights.ts"))
REPORT = os.path.join(HERE, "report.json")

AUC_KILL_THRESHOLD = 0.70


def log(m):
    print(f"[fit] {m}", file=sys.stderr)


def load_corpus():
    if not os.path.exists(MANIFEST):
        log(f"no manifest at {MANIFEST}. Run scrape.py and populate corpus/llm/ first.")
        sys.exit(1)
    X, y, meta, skipped = [], [], [], 0
    with open(MANIFEST, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            path = os.path.join(CORPUS, row["path"])
            if not os.path.exists(path):
                continue
            with open(path, encoding="utf-8") as fh:
                body = fh.read()
            vec, skip = feature_vector(body)
            if vec is None:
                skipped += 1
                continue
            X.append(vec)
            y.append(1 if row["label"] == "llm" else 0)  # 1 = synthetic
            meta.append({"label": row["label"], "subreddit": row.get("subreddit", "")})
    return np.array(X, dtype=float), np.array(y, dtype=int), meta, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--test-size", type=float, default=0.25)
    args = ap.parse_args()

    X, y, meta, skipped = load_corpus()
    n_human = int((y == 0).sum())
    n_llm = int((y == 1).sum())
    log(f"loaded {len(y)} usable posts ({n_human} human, {n_llm} llm); {skipped} skipped (too short/long)")

    if n_human < 20 or n_llm < 20:
        log("FATAL: need >=20 of each class to fit anything meaningful. Add more corpus.")
        sys.exit(2)

    Xtr, Xte, ytr, yte = train_test_split(
        X, y, test_size=args.test_size, random_state=args.seed, stratify=y
    )

    # Standardise so coefficients are comparable, but we BAKE the scaling back
    # into the exported coefficients so slop.ts can keep using raw features.
    mu = Xtr.mean(axis=0)
    sd = Xtr.std(axis=0)
    sd[sd == 0] = 1.0
    Xtr_s = (Xtr - mu) / sd

    clf = LogisticRegression(max_iter=2000, C=1.0)
    clf.fit(Xtr_s, ytr)

    # Evaluate on held-out, scaling test set with TRAIN stats (no leakage).
    Xte_s = (Xte - mu) / sd
    proba = clf.predict_proba(Xte_s)[:, 1]
    auc = float(roc_auc_score(yte, proba)) if len(set(yte)) > 1 else float("nan")
    preds = (proba >= 0.5).astype(int)
    prec = float(precision_score(yte, preds, zero_division=0))
    rec = float(recall_score(yte, preds, zero_division=0))
    log(f"held-out AUC={auc:.3f}  precision={prec:.3f}  recall={rec:.3f}")

    # Un-standardise coefficients so slop.ts uses RAW features:
    #   z = b0 + sum(w_i * (x_i - mu_i)/sd_i)
    #     = (b0 - sum(w_i*mu_i/sd_i)) + sum((w_i/sd_i) * x_i)
    coef_s = clf.coef_[0]
    intercept_s = float(clf.intercept_[0])
    raw_coef = coef_s / sd
    raw_bias = intercept_s - float(np.sum(coef_s * mu / sd))

    weights = {"bias": float(raw_bias)}
    for k, w in zip(FEATURE_KEYS, raw_coef):
        weights[k] = float(w)

    killed = (not np.isnan(auc)) and auc < AUC_KILL_THRESHOLD
    mode = "boilerplate" if killed else "synthetic"
    # In boilerplate mode, only the top ~5% fire: raise the score>=1 threshold.
    decision_thresholds = [0.90, 0.95, 0.98] if killed else [0.50, 0.70, 0.85]

    if killed:
        log(f"AUC {auc:.3f} < {AUC_KILL_THRESHOLD} -> KILL THRESHOLD HIT.")
        log("Exporting in DEGRADED 'boilerplate detector' mode (top ~5%, high precision).")

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "corpus": {"human": n_human, "llm": n_llm, "skipped": skipped},
        "metrics": {"auc": auc, "precision": prec, "recall": rec},
        "killThreshold": AUC_KILL_THRESHOLD,
        "mode": mode,
        "decisionThresholds": decision_thresholds,
        "seed": args.seed,
    }
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    log(f"wrote {REPORT}")

    if args.dry_run:
        log("--dry-run: not writing TS weights.")
        print(json.dumps(report, indent=2))
        return

    write_ts(weights, mode, decision_thresholds, report)
    log(f"wrote {TS_OUT}")
    print(json.dumps(report, indent=2))


def write_ts(weights, mode, thresholds, report):
    keys_order = ["bias"] + FEATURE_KEYS
    lines = []
    lines.append("/**")
    lines.append(" * AUTO-GENERATED by tools/slop-trainer/fit.py. DO NOT EDIT BY HAND.")
    lines.append(f" * Generated: {report['generatedAt']}")
    lines.append(f" * Corpus: {report['corpus']['human']} human / {report['corpus']['llm']} llm")
    lines.append(f" * Held-out AUC: {report['metrics']['auc']:.3f}  (kill threshold {report['killThreshold']})")
    lines.append(f" * Mode: {mode}")
    lines.append(" *")
    lines.append(" * 'synthetic'  -> normal synthetic-text-likelihood framing, thresholds [0.50,0.70,0.85]")
    lines.append(" * 'boilerplate'-> AUC below kill threshold; degraded high-precision framing,")
    lines.append(" *                 only the top ~5% of posts score above 0.")
    lines.append(" */")
    lines.append("")
    lines.append('export type SlopMode = "synthetic" | "boilerplate";')
    lines.append("")
    lines.append("export const SLOP_MODE: SlopMode = " + json.dumps(mode) + ";")
    lines.append("")
    lines.append("/** Probability breakpoints for the 0..3 bucket mapping. */")
    lines.append("export const SLOP_DECISION_THRESHOLDS: readonly [number, number, number] = [" +
                 ", ".join(f"{t}" for t in thresholds) + "] as const;")
    lines.append("")
    lines.append("export const SLOP_WEIGHTS = {")
    for k in keys_order:
        lines.append(f"  {k}: {weights[k]:.6f},")
    lines.append("} as const;")
    lines.append("")
    os.makedirs(os.path.dirname(TS_OUT), exist_ok=True)
    with open(TS_OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
