/**
 * percentile math. pure functions, zero deps.
 *
 * computes and applies percentile breakpoints for a set of values.
 * used by the calibration rollup to build per-sub baselines, and by
 * the scoring path to convert raw feature values into 0..1 scores.
 */

export interface percentileBreakpoints {
  p25: number;
  p50: number;
  p70: number;
  p85: number;
  p95: number;
}

/**
 * compute percentile breakpoints from a sorted or unsorted array of numbers.
 * returns null if the array is empty.
 */
export function computePercentiles(values: number[]): percentileBreakpoints | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo] ?? 0;
    const frac = idx - lo;
    return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
  };

  return {
    p25: at(25),
    p50: at(50),
    p70: at(70),
    p85: at(85),
    p95: at(95),
  };
}

/**
 * convert a single value to a 0..1 percentile rank given precomputed breakpoints.
 *
 * the mapping is piecewise linear between the five anchor points:
 *   below p25  → 0..0.25
 *   p25..p50   → 0.25..0.50
 *   p50..p70   → 0.50..0.70
 *   p70..p85   → 0.70..0.85
 *   p85..p95   → 0.85..0.95
 *   above p95  → 0.95..1.0  (capped at 1.0)
 */
export function valueToPercentile(value: number, bp: percentileBreakpoints): number {
  const anchors: [number, number][] = [
    [0, 0],
    [bp.p25, 0.25],
    [bp.p50, 0.50],
    [bp.p70, 0.70],
    [bp.p85, 0.85],
    [bp.p95, 0.95],
  ];

  if (value <= (anchors[0]?.[0] ?? 0)) return 0;

  for (let i = 1; i < anchors.length; i++) {
    const [prevVal, prevPct] = anchors[i - 1] ?? [0, 0];
    const [curVal, curPct] = anchors[i] ?? [0, 0];
    if (value <= curVal) {
      if (curVal === prevVal) return prevPct;
      const t = (value - prevVal) / (curVal - prevVal);
      return prevPct + t * (curPct - prevPct);
    }
  }

  // above p95 — linearly extrapolate to cap at 1.0
  const lastVal = anchors[anchors.length - 1]?.[0] ?? bp.p95;
  const secondLastVal = anchors[anchors.length - 2]?.[0] ?? bp.p85;
  if (lastVal === secondLastVal) return 1;
  const t = (value - (anchors[anchors.length - 2]?.[0] ?? bp.p85)) /
            (lastVal - secondLastVal);
  return Math.min(1, 0.85 + t * 0.15);
}
