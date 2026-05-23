# corpus/llm — the synthetic (LLM-generated) half of the training set

This folder holds posts you **know** are LLM-generated, because you generated
them. Each `.txt` is one post body. The trainer labels everything in here as
`llm` (synthetic = 1).

## Why you generate these instead of scraping them

You cannot reliably scrape "LLM posts" off Reddit — you'd be guessing, and the
whole point of the classifier is that guessing is hard. The only way to get a
**trustworthy** synthetic label is to produce the text yourself from known
models. That's why `scrape.py` only fills `corpus/human/` (with a pre-2022
date guard) and never touches this folder.

## How to build this set (target ~200, to match ~200 human)

Generate AITAH/relationship-style posts from a spread of models so the
classifier doesn't overfit one model's tics:

- ChatGPT (GPT-4o / o-series)
- Claude
- Gemini
- Llama / Mistral (open models write differently — include them)

Prompt variety matters. Use several framings, e.g.:

- "Write a Reddit AITA post about a wedding seating dispute, ~250 words."
- "Write a relationship_advice post where OP is clearly the problem but doesn't
  realize it, first person, ~300 words."
- "Write a JustNoMIL story about a holiday boundary, casual tone, ~200 words."

Vary length (100–600 words), tone, and topic. If every synthetic post is 250
words of the same register, the classifier learns "250 words = AI", which is
useless.

## File format

- One post body per file. Plain text. No title line, no metadata.
- Name them however you like; `gpt4o__0001.txt`, `claude__0002.txt`, etc. helps
  you track model spread.
- Put each file directly in this folder.

## Registering them in the manifest

After you drop files here, register them so `fit.py` picks them up:

```bash
python3 register_llm.py            # scans corpus/llm/, appends rows to manifest.csv
```

(If `register_llm.py` isn't present yet, the `make_synthetic_corpus.py` path or
a one-liner that appends `label=llm` rows for each file works too.)

## Privacy note

These are model outputs, not real users' posts. No author data, no real
usernames. Consistent with aurameter's reputation-free rule (plan §6.10): the
trainer never introduces per-user data the runtime is forbidden to keep.

## The honesty checkpoint

Before you trust the exported weights:

1. `corpus/human/` is **pre-2022** scraped posts (date-guarded by `scrape.py`).
2. `corpus/llm/` is **model-generated** posts you produced.
3. You deleted the synthetic placeholder rows (`source=synthetic-generated`)
   from `manifest.csv`.
4. `fit.py` reports held-out AUC **≥ 0.70**. If it's below, the file ships in
   degraded "boilerplate detector" mode automatically — that's the kill
   threshold doing its job, not a bug.
