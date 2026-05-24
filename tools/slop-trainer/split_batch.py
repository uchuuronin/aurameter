#!/usr/bin/env python3
"""
split_batch.py — cut a model's batch output into one .txt per post in corpus/llm/.

Handles both delimiter styles you've been getting from models:
  - "=====" on its own line  (claude / perplexity / gpt batches)
  - "# " at the start of a post (gemini batches)
and tolerates Windows CRLF line endings.

Skips posts under 30 words (fit.py would skip them anyway as "too short"),
so your registered count matches your usable count.

USAGE (run from tools/slop-trainer/):
  python split_batch.py <model> <batchfile>
  e.g.  python split_batch.py gemini gemini-aitah.txt
        python split_batch.py gpt    gpt_aitah.txt

Re-running for the same model appends (won't clobber earlier files).
"""
import sys, os, re

MIN_WORDS = 30
LLM_DIR = os.path.join("corpus", "llm")   # where split posts are WRITTEN
BATCH_DIR = "llm-txt"                      # where raw batch files are READ from

def split_posts(text: str):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if "=====" in text:
        chunks = text.split("=====")
    elif re.search(r"(?m)^#\s+", text):
        # gemini style: posts begin with "# ". Prepend \n so the first one splits too.
        chunks = re.split(r"(?m)^#\s+", "\n" + text)
    else:
        # fallback: blank-line-separated paragraphs of substance
        chunks = re.split(r"\n\s*\n\s*\n+", text)
    out = []
    for c in chunks:
        c = c.strip().lstrip("#").strip()
        if c:
            out.append(c)
    return out

def main():
    if len(sys.argv) != 3:
        print("usage: python split_batch.py <model> <batchfile>")
        sys.exit(1)
    model, src = sys.argv[1], sys.argv[2]
    os.makedirs(LLM_DIR, exist_ok=True)

    # Raw batch files now live in llm-txt/. If the user passed a bare filename,
    # look there. If they passed a path that exists as-is (or in the cwd), or a
    # path with no extension, fall back gracefully so old habits still work.
    candidates = [src, os.path.join(BATCH_DIR, src)]
    if not os.path.splitext(src)[1]:           # no extension given -> try .txt
        candidates.append(os.path.join(BATCH_DIR, src + ".txt"))
        candidates.append(src + ".txt")
    resolved = next((c for c in candidates if os.path.isfile(c)), None)
    if resolved is None:
        print(f"[split] ERROR: could not find '{src}'. Looked in: "
              + ", ".join(repr(c) for c in candidates))
        sys.exit(1)

    posts = split_posts(open(resolved, encoding="utf-8").read())
    existing = len([f for f in os.listdir(LLM_DIR) if f.startswith(model + "__")])

    written, skipped = 0, 0
    for post in posts:
        if len(post.split()) < MIN_WORDS:
            skipped += 1
            continue
        path = os.path.join(LLM_DIR, f"{model}__{existing + written:04d}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(post)
        written += 1

    print(f"[split] {model}: wrote {written} files"
          f"{f', skipped {skipped} (<{MIN_WORDS} words)' if skipped else ''}")

if __name__ == "__main__":
    main()