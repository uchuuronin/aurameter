#!/usr/bin/env python3
"""
aurameter slop-trainer :: scrape.py

Pulls REAL post bodies from drama subreddits into corpus/human/ for training the
Slop classifier. Uses Reddit's public JSON API (no auth, no PRAW) so it runs
anywhere with network access.

WHY THE DATE CUTOFF MATTERS (read this before you scrape):
  The Slop classifier learns "human prose" vs "LLM prose". If you label recent
  posts as "human", some of them are actually ChatGPT/Claude output and your
  labels are wrong. Wrong labels -> the classifier learns garbage -> worse than
  the placeholder weights it replaces.

  The plan (project-plan.md 9.4) specifies *pre-2022* posts for the human set
  for exactly this reason. Reddit's JSON API can't filter by date directly, but
  /top/?t=all on a mature sub surfaces old high-engagement posts, and we filter
  client-side on created_utc. We KEEP a post only if it was created before
  HUMAN_CUTOFF_UTC. Everything else is dropped with a logged reason.

  For the LLM half of the corpus you do NOT scrape: you generate. See
  corpus/llm/README so the labels are trustworthy.

USAGE:
  python3 scrape.py --subs AmItheAsshole tifu --target 250
  python3 scrape.py --subs AmItheAsshole AITAH JustNoMIL --target 250 --min-words 120

OUTPUT:
  corpus/human/<sub>__<postid>.txt    one cleaned body per file
  corpus/manifest.csv                 label,source,subreddit,postid,created_utc,words,path

NOTE ON POLITENESS / TOS:
  - Single-threaded, sleeps between requests (default 2s) to respect rate limits.
  - Sets a descriptive User-Agent as Reddit asks.
  - Stores only post BODY text + a post id. No usernames, no author field, no
    comments. This mirrors aurameter's reputation-free rule (plan 6.10): the
    trainer must not introduce per-user data the runtime is forbidden to keep.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
HUMAN_DIR = os.path.join(CORPUS, "human")
MANIFEST = os.path.join(CORPUS, "manifest.csv")

# Pre-2022 cutoff. Posts created at/after this are dropped from the HUMAN set
# because we can't trust the "human" label after LLMs became widely used.
HUMAN_CUTOFF_UTC = int(datetime(2022, 1, 1, tzinfo=timezone.utc).timestamp())

USER_AGENT = "aurameter-slop-trainer/1.0 (research; contact: your-reddit-username)"


def log(msg: str) -> None:
    print(f"[scrape] {msg}", file=sys.stderr)


def clean_body(text: str) -> str:
    """Light cleanup: strip markdown links, collapse whitespace, drop edit/update tails.

    Deliberately conservative — the stylometric features in slop.ts measure raw
    human writing patterns, so we don't want to over-normalise away the very
    variance we're trying to learn."""
    if not text:
        return ""
    # Remove zero-width and HTML entities Reddit sometimes leaves in JSON.
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("\u200b", "")
    # Strip markdown link syntax [label](url) -> label
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1", text)
    # Drop bare URLs
    text = re.sub(r"https?://\S+", "", text)
    # Collapse 3+ newlines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def fetch_json(url: str, retries: int = 3, backoff: float = 3.0):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = backoff * (attempt + 1)
                log(f"429 rate-limited, sleeping {wait}s")
                time.sleep(wait)
                continue
            log(f"HTTP {e.code} on {url}")
            return None
        except Exception as e:  # noqa: BLE001
            log(f"error {e} on {url}; retry {attempt+1}/{retries}")
            time.sleep(backoff)
    return None


def scrape_sub(sub: str, target: int, min_words: int, sleep: float):
    """Page through /top/?t=all collecting pre-cutoff selftext posts."""
    collected = []
    after = None
    seen = 0
    pages = 0
    while len(collected) < target and pages < 40:
        url = f"https://www.reddit.com/r/{sub}/top.json?t=all&limit=100"
        if after:
            url += f"&after={after}"
        data = fetch_json(url)
        pages += 1
        if not data or "data" not in data:
            log(f"r/{sub}: no data on page {pages}, stopping")
            break
        children = data["data"].get("children", [])
        if not children:
            break
        for ch in children:
            d = ch.get("data", {})
            seen += 1
            if not d.get("is_self"):
                continue
            created = int(d.get("created_utc", 0))
            if created >= HUMAN_CUTOFF_UTC:
                continue  # contamination guard
            body = clean_body(d.get("selftext", ""))
            words = len(body.split())
            if words < min_words:
                continue
            collected.append({
                "subreddit": sub,
                "postid": d.get("id", ""),
                "created_utc": created,
                "words": words,
                "body": body,
            })
            if len(collected) >= target:
                break
        after = data["data"].get("after")
        if not after:
            break
        time.sleep(sleep)
    log(f"r/{sub}: kept {len(collected)} / scanned {seen}")
    return collected


def main():
    ap = argparse.ArgumentParser(description="Scrape pre-2022 human posts for slop training.")
    ap.add_argument("--subs", nargs="+", required=True, help="subreddit names without r/")
    ap.add_argument("--target", type=int, default=250, help="posts to keep PER SUB (cap)")
    ap.add_argument("--min-words", type=int, default=100, help="skip posts shorter than this")
    ap.add_argument("--sleep", type=float, default=2.0, help="seconds between page requests")
    args = ap.parse_args()

    os.makedirs(HUMAN_DIR, exist_ok=True)

    rows = []
    for sub in args.subs:
        posts = scrape_sub(sub, args.target, args.min_words, args.sleep)
        for p in posts:
            fname = f"{sub}__{p['postid']}.txt"
            path = os.path.join(HUMAN_DIR, fname)
            with open(path, "w", encoding="utf-8") as f:
                f.write(p["body"])
            rows.append({
                "label": "human",
                "source": "reddit-scrape",
                "subreddit": sub,
                "postid": p["postid"],
                "created_utc": p["created_utc"],
                "words": p["words"],
                "path": os.path.relpath(path, CORPUS),
            })

    # Append to manifest (don't clobber the llm rows if they exist).
    existing = []
    if os.path.exists(MANIFEST):
        with open(MANIFEST, newline="", encoding="utf-8") as f:
            existing = [r for r in csv.DictReader(f) if r.get("source") != "reddit-scrape"]
    fieldnames = ["label", "source", "subreddit", "postid", "created_utc", "words", "path"]
    with open(MANIFEST, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in existing:
            w.writerow({k: r.get(k, "") for k in fieldnames})
        for r in rows:
            w.writerow(r)

    total_human = len(rows)
    log(f"DONE. Wrote {total_human} human posts across {len(args.subs)} subs.")
    log(f"Manifest: {MANIFEST}")
    if total_human < 150:
        log("WARNING: < 150 human posts. The fit will be weak. Scrape more subs or lower --min-words.")
    log("NEXT: populate corpus/llm/ with generated posts (see corpus/llm/README.md), then run fit.py")


if __name__ == "__main__":
    main()
