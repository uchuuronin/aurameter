#!/usr/bin/env python3
"""
aurameter slop-trainer :: register_llm.py

Scans corpus/llm/*.txt and appends one `label=llm` row per file to
manifest.csv. Idempotent: it rewrites all llm rows from the current folder
contents, so re-running after adding files just picks up the new ones.

Also offers --purge-synthetic to drop the synthetic placeholder rows once you
have real data, which is the honesty checkpoint from corpus/llm/README.md.

USAGE:
  python3 register_llm.py                 # register corpus/llm/*.txt
  python3 register_llm.py --purge-synthetic   # also remove source=synthetic-generated rows
"""

import argparse
import csv
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
LLM = os.path.join(CORPUS, "llm")
MANIFEST = os.path.join(CORPUS, "manifest.csv")
FIELDS = ["label", "source", "subreddit", "postid", "created_utc", "words", "path"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--purge-synthetic", action="store_true",
                    help="remove rows with source=synthetic-generated (use once real data exists)")
    args = ap.parse_args()

    # Load existing rows we want to keep (everything that isn't a real-llm row
    # from this folder — we rebuild those fresh).
    keep = []
    if os.path.exists(MANIFEST):
        with open(MANIFEST, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                is_real_llm = (r.get("label") == "llm" and r.get("source") == "llm-handmade")
                is_synth = (r.get("source") == "synthetic-generated")
                if is_real_llm:
                    continue  # rebuilt below
                if args.purge_synthetic and is_synth:
                    continue
                keep.append({k: r.get(k, "") for k in FIELDS})

    # Scan the folder for real llm files (skip the README).
    new_rows = []
    if os.path.isdir(LLM):
        for name in sorted(os.listdir(LLM)):
            if not name.endswith(".txt"):
                continue
            path = os.path.join(LLM, name)
            body = open(path, encoding="utf-8").read()
            words = len(body.split())
            postid = os.path.splitext(name)[0]
            new_rows.append({
                "label": "llm",
                "source": "llm-handmade",
                "subreddit": "GENERATED",
                "postid": postid,
                "created_utc": 0,
                "words": words,
                "path": os.path.relpath(path, CORPUS),
            })

    with open(MANIFEST, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in keep:
            w.writerow(r)
        for r in new_rows:
            w.writerow(r)

    print(f"[register_llm] registered {len(new_rows)} llm files; kept {len(keep)} other rows")
    if args.purge_synthetic:
        print("[register_llm] purged synthetic placeholder rows")
    if not new_rows:
        print("[register_llm] NOTE: corpus/llm/ has no .txt files yet — see corpus/llm/README.md")


if __name__ == "__main__":
    main()
