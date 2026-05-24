#!/usr/bin/env python3
"""
aurameter slop-trainer :: make_synthetic_corpus.py

Generates a SYNTHETIC, clearly-labeled corpus so the training pipeline
(features -> fit -> AUC -> export) can be proven to run end-to-end BEFORE the
real 400-500 post corpus is assembled.

THIS IS NOT TRAINING DATA YOU SHOULD SHIP WEIGHTS FROM.
The weights fit on this synthetic corpus are meaningless for real detection —
they only prove the plumbing works. When your real corpus lands in
corpus/human/ (from scrape.py) and corpus/llm/ (hand-generated), delete the
synthetic rows from the manifest and re-run fit.py.

The generator builds:
  - "human" texts: high sentence-length variance, profanity, questions, varied
    openers, no GPT fingerprints. (Mimics the real human signal.)
  - "llm" texts: smooth sentence lengths, GPT fingerprint phrases, hedging,
    no profanity, repetitive openers. (Mimics the real synthetic signal.)

Because these are built from the SAME feature axes slop.ts measures, a correct
pipeline will recover a high AUC here. That's the point: it validates the
pipeline, it does not validate real-world detection.
"""

import argparse
import csv
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
SYN = os.path.join(CORPUS, "_synthetic")
HUMAN = os.path.join(SYN, "human")
LLM = os.path.join(SYN, "llm")
MANIFEST = os.path.join(CORPUS, "manifest.csv")

HUMAN_CLAUSES = [
    "So this happened last night and I'm still pissed.",
    "My sister showed up uninvited.",
    "What the hell was I supposed to do?",
    "I told her to leave.",
    "She screamed at me in front of everyone, can you believe that?",
    "Honestly I don't even know anymore.",
    "He just stood there.",
    "Am I the asshole here or what?",
    "We've been fighting about money for months.",
    "Then the dog knocked over the cake and everyone lost it.",
    "I work two jobs and I'm exhausted.",
    "My mom called me selfish which is rich coming from her.",
    "Anyway.",
    "Tell me I'm not crazy.",
]

LLM_CLAUSES = [
    "It's important to note that family dynamics can be quite nuanced.",
    "On the other hand, one might consider the perspective of the other party.",
    "Furthermore, navigating the complexities of these relationships is paramount.",
    "Generally speaking, communication tends to be the foundation of resolution.",
    "Moreover, it is often the case that misunderstandings arise from assumptions.",
    "In conclusion, approaching the situation with empathy may prove beneficial.",
    "Perhaps the most crucial element is mutual respect and understanding.",
    "This situation underscores the importance of setting healthy boundaries.",
    "Firstly, it would be prudent to reflect on the underlying emotions involved.",
    "Secondly, one should delve into the root causes of the conflict.",
]


def make_human(rng: random.Random) -> str:
    n = rng.randint(8, 16)
    parts = [rng.choice(HUMAN_CLAUSES) for _ in range(n)]
    return " ".join(parts)


def make_llm(rng: random.Random) -> str:
    n = rng.randint(8, 16)
    parts = [rng.choice(LLM_CLAUSES) for _ in range(n)]
    return " ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=120, help="posts per class")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    os.makedirs(HUMAN, exist_ok=True)
    os.makedirs(LLM, exist_ok=True)

    rows = []
    for i in range(args.n):
        h = make_human(rng)
        path = os.path.join(HUMAN, f"synthetic__human_{i:04d}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(h)
        rows.append(["human", "synthetic-generated", "SYNTHETIC", f"h{i:04d}", 0,
                     len(h.split()), os.path.relpath(path, CORPUS)])

        l = make_llm(rng)
        path = os.path.join(LLM, f"synthetic__llm_{i:04d}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(l)
        rows.append(["llm", "synthetic-generated", "SYNTHETIC", f"l{i:04d}", 0,
                     len(l.split()), os.path.relpath(path, CORPUS)])

    fieldnames = ["label", "source", "subreddit", "postid", "created_utc", "words", "path"]
    with open(MANIFEST, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(fieldnames)
        w.writerows(rows)

    print(f"wrote {len(rows)} synthetic posts ({args.n}/class) and manifest.csv")
    print("REMINDER: synthetic corpus validates the pipeline only. Replace with real data before shipping weights.")


if __name__ == "__main__":
    main()
