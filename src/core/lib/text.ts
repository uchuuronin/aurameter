/**
 * Shared text utilities used by all four signal extractors.
 *
 * Performance note: all four extractors run inside the onPostSubmit handler,
 * so these helpers must stay cheap. No tokenisation library, no async, no
 * external deps. Just regex and string operations.
 */

/** Cheap sentence split. Not linguistically perfect, but fast and good enough. */
export function splitSentences(text: string): string[] {
  // Split on ., !, ? followed by whitespace and a capital letter, or at end of string.
  // Falls back to single-sentence if no terminators found.
  const matches = text.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (!matches || matches.length === 0) {
    return text.trim() ? [text.trim()] : [];
  }
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Word count, splitting on whitespace. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Count regex matches in text, case-insensitive by default. */
export function countMatches(text: string, pattern: RegExp): number {
  // Ensure global flag, preserve other flags.
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const re = new RegExp(pattern.source, flags);
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** Density per 100 words. Returns 0 for empty text. */
export function densityPer100Words(text: string, pattern: RegExp): number {
  const words = wordCount(text);
  if (words === 0) return 0;
  return (countMatches(text, pattern) / words) * 100;
}

/** Sample variance. Returns 0 for arrays of length < 2. */
export function variance(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const squaredDiffs = nums.map((n) => (n - mean) ** 2);
  return squaredDiffs.reduce((a, b) => a + b, 0) / (nums.length - 1);
}

/** Type-token ratio: unique words / total words. Higher = more varied vocabulary. */
export function typeTokenRatio(text: string): number {
  const words = text.toLowerCase().match(/\b[a-z']+\b/g);
  if (!words || words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

/** Logistic function for mapping a feature sum to a 0–1 probability. */
export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Map a 0–1 score to a discrete level using threshold breakpoints. */
export function bucketScore(score01: number, thresholds: number[]): number {
  // thresholds = [0.5, 0.7, 0.85] for a 0-3 scale means:
  //   < 0.5 → 0, < 0.7 → 1, < 0.85 → 2, else → 3.
  let level = 0;
  for (const t of thresholds) {
    if (score01 >= t) level++;
  }
  return level;
}
