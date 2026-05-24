#!/usr/bin/env bash
# Bundles ts_score_harness.mts (which imports the real slop.ts runtime) into a
# single runnable .mjs, resolving the TS '.js'-extension import convention.
# Requires esbuild on PATH or set ESBUILD=/path/to/esbuild.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ESBUILD="${ESBUILD:-esbuild}"
"$ESBUILD" "$HERE/ts_score_harness.mts" \
  --bundle --platform=node --format=esm \
  --outfile="$HERE/_harness_bundled.mjs" \
  --resolve-extensions=.ts,.mts,.js,.mjs
echo "built $HERE/_harness_bundled.mjs"
