# Slop model retraining — local runbook

This is the **outside-Devvit** half of the Block 2 Slop loop. The app banks a
labeled corpus and flags retrain-readiness; it cannot fit a model. This runbook
is the manual chain a maintainer runs between releases to turn that corpus into
updated `slop_weights.ts`.

> **Why a runbook and not a GitHub Action.** The plan (Task 9 Step 3) sketches a
> scheduled CI workflow. We are out of GitHub Actions minutes, so the canonical
> path is this local runbook. The CI workflow remains a documented future
> option (see `retrain.yml.example` if/when minutes are available); nothing in
> the app depends on it.

## When to run

The app logs a `retrain due` entry (and you'll see it in the action log) once,
per the scheduler check:

- it has been longer than `RETRAIN_INTERVAL` (~6–8 weeks) since the last retrain, **and**
- the global corpus has at least `MIN_RETRAIN_CORPUS` entries.

You can also run it ad hoc. The corpus only grows; running early just trains on
less data.

## One-time setup

```bash
# from repo root
cd tools/slop-trainer
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt  # scikit-learn, numpy (fit.py's deps)
```

Set the export secret the app checks (`GET /api/corpus/export` is guarded):

```bash
# must match the CORPUS_EXPORT_SECRET configured in the app's environment
export CORPUS_EXPORT_SECRET='…'   # Windows: $env:CORPUS_EXPORT_SECRET='…'
```

## The chain

### 1. Pull the corpus (JSONL)

The export endpoint streams newline-delimited JSON (one `{id,ts,features,label,source}`
per line), oldest-first. It requires the secret header:

```bash
curl -fsS \
  -H "x-corpus-export-secret: $CORPUS_EXPORT_SECRET" \
  "https://<your-app-host>/api/corpus/export" \
  -o corpus.jsonl

wc -l corpus.jsonl   # sanity: should be >= MIN_RETRAIN_CORPUS
```

If you get `403 {"error":"export not configured"}`, the app has no
`CORPUS_EXPORT_SECRET` set — the endpoint fails safe (closed) until it does.
`403 {"error":"forbidden"}` means your header didn't match.

### 2. Fit

`fit.py` reads the JSONL, builds the feature matrix in the **canonical key order**
(`SLOP_FEATURE_KEYS`, the single source of truth exported from
`src/core/signals/slop.ts` and consumed by the parity harness), trains the
classifier, and prints AUC on a held-out split.

```bash
python fit.py --in corpus.jsonl --out slop_weights.candidate.json
```

### 3. Gate on AUC

The trainer enforces the **0.70 kill-threshold**. If the candidate's held-out
AUC is below 0.70, it refuses to emit weights — do **not** hand-edit around this.
The shipped model is AUC ~0.890; a candidate materially below that is a signal
the corpus is contaminated (most likely a purity-filter regression) rather than
a reason to ship.

### 4. Verify feature parity BEFORE committing

This is the step that has bitten us. The TS scorer and the Python trainer must
agree on the feature vector byte-for-byte. Rebuild the parity harness and run it:

```bash
# NOTE: build_harness.sh assumes a POSIX /bin/bash. On this Windows/WSL setup
# that script fails (no /bin/bash). Use the esbuild invocation directly:
npx esbuild ts_score_harness.mts \
  --bundle --platform=node --format=esm \
  --outfile=_harness_bundled.mjs \
  --resolve-extensions=.ts,.mts,.js,.mjs

node _harness_bundled.mjs   # expect: "✅ … identical features. Weights are valid."
```

If parity fails, the weights are not safe to ship regardless of AUC — the
trainer learned on features the scorer won't reproduce.

### 5. Promote + commit

Only after AUC ≥ 0.70 **and** parity is green:

```bash
# convert the candidate JSON into the TS weights module
python emit_weights_ts.py --in slop_weights.candidate.json --out ../../src/core/signals/slop_weights.ts

cd ../..
npm run type-check && npm run lint && npm run test   # full static gate
git add src/core/signals/slop_weights.ts
git commit -m "model(slop): retrain on corpus (AUC <fill in>, parity green)"
```

### 6. Record the retrain

After deploying the new weights, the next scheduler tick should see `lastRetrainAt`
advanced so it stops logging `retrain due`. (If `lastRetrainAt` is stored in
Redis rather than derived, update it as documented in `scheduler.ts`.)

## Invariants (do not violate)

- **Global model only.** Never train per-sub weights. Per-sub divergence lives
  entirely in the threshold (the percentile baseline), not the model.
- **Corpus is feature-vectors + labels only.** No sub names, titles, bodies, or
  author identity ever leave the app. If `corpus.jsonl` ever contains any of
  those, stop — that's a privacy regression in the export path.
- **0.70 is a kill-threshold, not a target.** Below it, ship nothing.
- **Parity is a hard gate.** AUC means nothing if the scorer can't reproduce the
  training features.
