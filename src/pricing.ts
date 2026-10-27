// Official DeepSeek V4.1-Flash ("deepseek-v4.1-flash") pricing and per-run cost
// computation for benchmark reports and the loop's hard USD budget.
//
// Rates are USD per 1M tokens, fetched 2026-10-27 from
// https://api-docs.deepseek.com/quick_start/pricing:
//
//   cache-hit input    $0.006
//   cache-miss input   $0.30
//   output             $1.20
//
// The official page lists off-peak rates at half of peak, but cost
// accounting deliberately uses peak prices unconditionally: a run measured at
// any wall-clock time is priced at the peak rate so reports are comparable
// across runs and never benefit from an off-peak measurement window.
//
// Bucket normalization (the sides report different conventions):
// - tc (OpenAI format): `input` includes cache hits, so miss = input - cacheRead
//   (clamped at zero) and hit = cacheRead.
// - oc (session export): `input` excludes cache reads, so miss = input and
//   hit = cacheRead.
// - Output is priced together with reasoning: both counters are added and
//   charged at the output rate.
// - `cacheWrite` is currently null/0 in every recorded run; if a side ever
//   reports it, it is priced at the cache-miss rate.
//
// There are two USD views:
// - Full cost prices cache-hit input, cache-miss input, and output.
// - Billable cost is the cache-excluded, like-for-like view: cache-miss input
//   plus output, priced at peak. Cache-hit input is deliberately excluded.
//   Billable cost drives the comparison tables and the loop's USD budget.
//
// Keep the source URL and fetch date next to the constants: DeepSeek may change
// prices, and a change invalidates measured cost rows.

export const PRICING_SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";
export const PRICING_FETCHED_ON = "2026-10-27";

export type BenchmarkSide = "tc" | "oc";

/** Token buckets as recorded in result rows; null means the side did not report it. */
export interface TokenBuckets {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
}

/** USD per 1M tokens at the official peak rate. */
export interface RateCard {
  readonly cacheHitInputPerMillion: number;
  /** Also used for cache writes: no separate write rate is published. */
  readonly cacheMissInputPerMillion: number;
  readonly outputPerMillion: number;
}

export const PEAK_RATES_PER_MILLION: RateCard = {
  cacheHitInputPerMillion: 0.006,
  cacheMissInputPerMillion: 0.3,
  outputPerMillion: 1.2,
};

export interface NormalizedBuckets {
  readonly miss: number;
  readonly hit: number;
  readonly output: number;
}

/** Normalizes the per-side token buckets (see the module header). */
export function normalizeBuckets(buckets: TokenBuckets, side: BenchmarkSide): NormalizedBuckets {
  const input = buckets.input ?? 0;
  const hit = buckets.cacheRead ?? 0;
  const write = buckets.cacheWrite ?? 0;
  const miss = (side === "tc" ? Math.max(0, input - hit) : input) + write;
  const output = (buckets.output ?? 0) + (buckets.reasoning ?? 0);
  return { miss, hit, output };
}

/** Cost in USD of one bucket set at one rate card. */
export function costAtRates(
  buckets: TokenBuckets,
  side: BenchmarkSide,
  rates: RateCard = PEAK_RATES_PER_MILLION,
): number {
  const { miss, hit, output } = normalizeBuckets(buckets, side);
  return (
    (miss * rates.cacheMissInputPerMillion +
      hit * rates.cacheHitInputPerMillion +
      output * rates.outputPerMillion) /
    1_000_000
  );
}

/** Full USD cost at the official peak rate, regardless of wall-clock time. */
export function peakCost(buckets: TokenBuckets, side: BenchmarkSide): number {
  return costAtRates(buckets, side, PEAK_RATES_PER_MILLION);
}

/**
 * Cache-excluded, like-for-like USD triple: `in` is cache-miss input, `out` is
 * output (reasoning included), and `total = in + out`, all priced at peak.
 * Cache-hit input is deliberately excluded so the two sides compare on the
 * same basis and the loop's budget measures work rather than cache luck.
 */
export interface BillableCost {
  readonly in: number;
  readonly out: number;
  readonly total: number;
}

/** Cache-excluded USD at one rate card, via `normalizeBuckets`. */
export function billableCostAtRates(
  buckets: TokenBuckets,
  side: BenchmarkSide,
  rates: RateCard = PEAK_RATES_PER_MILLION,
): BillableCost {
  const { miss, output } = normalizeBuckets(buckets, side);
  const input = (miss * rates.cacheMissInputPerMillion) / 1_000_000;
  const outputCost = (output * rates.outputPerMillion) / 1_000_000;
  return { in: input, out: outputCost, total: input + outputCost };
}

/** Cache-excluded USD at the official peak rate. */
export function billableCost(buckets: TokenBuckets, side: BenchmarkSide): BillableCost {
  return billableCostAtRates(buckets, side, PEAK_RATES_PER_MILLION);
}

/** The loop's tc-shaped token tally, structurally typed to avoid an import cycle. */
export interface LoopTokenBuckets {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly reasoning: number;
}

/**
 * Cache-excluded USD charged against the loop's hard budget for one provider
 * response. tc `input` includes cache hits, so the miss is `input - cacheRead`.
 */
export function billableCostForLoopTokens(tokens: LoopTokenBuckets): number {
  return billableCost(
    {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: 0,
      reasoning: tokens.reasoning,
    },
    "tc",
  ).total;
}
