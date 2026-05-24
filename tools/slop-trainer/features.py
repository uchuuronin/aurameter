#!/usr/bin/env python3
"""
aurameter slop-trainer :: features.py

EXACT Python port of the 10 feature computations in src/core/signals/slop.ts.

THIS FILE IS THE CONTRACT. The whole training pipeline is worthless if the
features computed here diverge from the features computed at runtime in
slop.ts. If you change a regex or a formula in slop.ts, change it here too,
then re-fit. There is a parity test (test_parity.py) that guards this.

The feature ORDER returned by feature_vector() must match the WEIGHT_KEYS order
in fit.py and the order slop.ts reads them. Don't reorder casually.
"""

import math
import re
from typing import Dict, List

# ── regexes: copied verbatim from slop.ts (Python flavour) ──────────────────
# JS used /.../gi ; Python uses re.IGNORECASE. Word boundaries and alternations
# are identical. The apostrophe class ['’] in JS becomes ['’] here.

GPT_FINGERPRINT = re.compile(
    r"\b(delve|delv(?:ing|ed)|tapestry|navigate the complexities|in the realm of|"
    r"it['’]s important to note|on the other hand|moreover|furthermore|in conclusion|"
    r"firstly|secondly|nuanced|paramount|underscore|underscores|leverag(?:e|ing|ed))\b",
    re.IGNORECASE,
)
HEDGE = re.compile(
    r"\b(might|perhaps|generally|tend(?:s)? to|often|usually|in some cases|it depends|"
    r"to some extent|in many ways|relatively|somewhat|seemingly)\b",
    re.IGNORECASE,
)
PROFANITY = re.compile(
    r"\b(fuck|shit|damn|hell|ass(?:hole)?|bitch|crap|piss|bullshit)\w*\b",
    re.IGNORECASE,
)
EM_DASH = re.compile(r":|–")
OXFORD_COMMA = re.compile(r",\s+(?:and|or)\s+")
QUESTION = re.compile(r"\?")

MAX_BODY_CHARS = 5000

# ── text helpers: ports of src/core/lib/text.ts ─────────────────────────────


def split_sentences(text: str) -> List[str]:
    matches = re.findall(r"[^.!?]+[.!?]+(?=\s|$)", text)
    if not matches:
        t = text.strip()
        return [t] if t else []
    return [m.strip() for m in matches if m.strip()]


def word_count(text: str) -> int:
    t = text.strip()
    if not t:
        return 0
    return len(re.split(r"\s+", t))


def count_matches(text: str, pattern: re.Pattern) -> int:
    return len(pattern.findall(text))


def variance(nums: List[float]) -> float:
    """Sample variance (n-1). Matches text.ts::variance, which returns 0 for n<2."""
    if len(nums) < 2:
        return 0.0
    mean = sum(nums) / len(nums)
    return sum((n - mean) ** 2 for n in nums) / (len(nums) - 1)


def type_token_ratio(text: str) -> float:
    words = re.findall(r"\b[a-z']+\b", text.lower())
    if not words:
        return 0.0
    return len(set(words)) / len(words)


def logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def sentence_opener_diversity(sentences: List[str]) -> float:
    if len(sentences) < 3:
        return 1.0
    openers = [(s.strip().split() or [""])[0].lower() for s in sentences]
    counts: Dict[str, int] = {}
    for w in openers:
        counts[w] = counts.get(w, 0) + 1
    mx = max(counts.values())
    return 1.0 - mx / len(sentences)


# ── the 10 features, in the exact order slop.ts multiplies them by weights ──
# Keys MUST match SLOP_WEIGHTS in slop.ts (minus 'bias').

FEATURE_KEYS = [
    "invSentenceLengthVariance",
    "fingerprintRate",
    "hedgeRate",
    "emDashRate",
    "oxfordRate",
    "invTypeTokenRatio",
    "invOpenerDiversity",
    "invQuestionRate",
    "profanityRate",
]


def extract_features(body: str):
    """Return (features_dict, skipped_reason_or_None).

    Mirrors slop.ts::extract exactly, including the two early-exit guards.
    When skipped, returns (None, reason)."""
    if len(body) > MAX_BODY_CHARS:
        return None, "too_long"

    sentences = split_sentences(body)
    words = word_count(body)
    if words < 30 or len(sentences) < 2:
        return None, "too_short"

    sentence_lengths = [word_count(s) for s in sentences]
    sent_len_var = variance([float(x) for x in sentence_lengths])
    inv_sent_len_var = 1.0 / (1.0 + sent_len_var / 50.0)

    fingerprint_hits = count_matches(body, GPT_FINGERPRINT)
    fingerprint_rate = (fingerprint_hits / words) * 100.0

    hedge_hits = count_matches(body, HEDGE)
    hedge_rate = (hedge_hits / words) * 100.0

    em_dash_hits = count_matches(body, EM_DASH)
    em_dash_rate = (em_dash_hits / words) * 100.0

    oxford_hits = count_matches(body, OXFORD_COMMA)
    oxford_rate = oxford_hits / len(sentences)

    ttr = type_token_ratio(body)
    inv_ttr = 1.0 - ttr

    opener_div = sentence_opener_diversity(sentences)
    inv_opener_div = 1.0 - opener_div

    question_hits = count_matches(body, QUESTION)
    question_rate = question_hits / len(sentences)
    inv_question_rate = 1.0 / (1.0 + question_rate * 5.0)

    profanity_hits = count_matches(body, PROFANITY)
    profanity_rate = (profanity_hits / words) * 100.0

    feats = {
        "invSentenceLengthVariance": inv_sent_len_var,
        "fingerprintRate": fingerprint_rate,
        "hedgeRate": hedge_rate,
        "emDashRate": em_dash_rate,
        "oxfordRate": oxford_rate,
        "invTypeTokenRatio": inv_ttr,
        "invOpenerDiversity": inv_opener_div,
        "invQuestionRate": inv_question_rate,
        "profanityRate": profanity_rate,
    }
    return feats, None


def feature_vector(body: str):
    feats, skip = extract_features(body)
    if feats is None:
        return None, skip
    return [feats[k] for k in FEATURE_KEYS], None


def score_with_weights(body: str, weights: Dict[str, float]):
    """Replicates slop.ts scoring end-to-end given a weight dict (incl 'bias').
    Returns (probability, score_0_3) or (None, None) if skipped."""
    feats, skip = extract_features(body)
    if feats is None:
        return None, None
    linear = weights["bias"]
    for k in FEATURE_KEYS:
        linear += weights[k] * feats[k]
    prob = logistic(linear)
    # bucketScore(prob, [0.5, 0.7, 0.85])
    score = 0
    for t in (0.5, 0.7, 0.85):
        if prob >= t:
            score += 1
    return prob, score
