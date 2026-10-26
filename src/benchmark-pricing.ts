// Official DeepSeek V4.1-Flash ("deepseek-flash") pricing and per-run cost
// computation for benchmark runs (#63).
//
// Rates are USD per 1M tokens, fetched 2026-10-19 from
// https://api-docs.deepseek.com/quick_start/pricing:
//
//   cache-hit input    $0.006 peak / $0.003 off-peak
//   cache-miss input   $0.30  peak / $0.15  off-peak
//   output             $1.20  peak / $0.60  off-peak
//
// Off-peak is half of peak. Peak hours are 01:00-04:00 and 06:00-10:00 UTC,
// Monday-Friday, excluding Chinese public holidays; every other hour is
// off-peak.
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
// `normalizeBuckets` is also the single source of the report's like-for-like
// token total (#89): total = cache-miss input + output, with cache-hit input
// excluded. That is the cross-side comparison metric; the raw provider buckets
// stay in each result row. The tc loop's `cacheExcludedTokens` (src/loop.ts)
// applies the same formula to loop-call buckets for the `cache-excluded` budget
// basis and the report's `billable.loop` split (#47).
//
// Straddling runs: when a run crosses a peak/off-peak boundary, its cost is the
// elapsed-time share blend of the peak and off-peak costs. This assumes tokens
// are spent uniformly over the run's wall-clock window (a documented
// approximation: real spend is bursty and request-shaped, and the window covers
// the side's model work only).
//
// Keep the source URL, fetch date, and the holiday list next to the constants:
// DeepSeek may change prices, and the 2026 list is calendar-specific.

export const PRICING_SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";
export const PRICING_FETCHED_ON = "2026-10-19";

export type BenchmarkSide = "tc" | "oc";
export type RateClass = "peak" | "off-peak" | "mixed";

/** Token buckets as recorded in result rows; null means the side did not report it. */
export interface TokenBuckets {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
}

/** USD per 1M tokens for one rate class. */
export interface RateCard {
  readonly cacheHitInputPerMillion: number;
  /** Also used for cache writes: no separate write rate is published. */
  readonly cacheMissInputPerMillion: number;
  readonly outputPerMillion: number;
}

export const OFF_PEAK_RATES_PER_MILLION: RateCard = {
  cacheHitInputPerMillion: 0.003,
  cacheMissInputPerMillion: 0.15,
  outputPerMillion: 0.6,
};

export const PEAK_RATES_PER_MILLION: RateCard = {
  cacheHitInputPerMillion: 0.006,
  cacheMissInputPerMillion: 0.3,
  outputPerMillion: 1.2,
};

// Chinese public holidays in 2026 (source:
// https://www.timeanddate.com/holidays/china/2026, fetched 2026-10-19), as
// inclusive UTC calendar dates. Peak windows fall on weekdays not listed here.
export const CN_2026_PUBLIC_HOLIDAYS: readonly string[] = [
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
];

/** Peak windows as minutes since UTC midnight, half-open ([start, end)). */
const PEAK_WINDOW_MINUTES: readonly { readonly start: number; readonly end: number }[] = [
  { start: 1 * 60, end: 4 * 60 },
  { start: 6 * 60, end: 10 * 60 },
];

const MINUTE_MS = 60_000;

function utcDateKey(date: Date): string {
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function isChineseHoliday(date: Date): boolean {
  return CN_2026_PUBLIC_HOLIDAYS.includes(utcDateKey(date));
}

/** True when the instant falls in a weekday peak window (holidays off). */
export function isPeakInstant(date: Date): boolean {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return false;
  }
  if (isChineseHoliday(date)) {
    return false;
  }
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  return PEAK_WINDOW_MINUTES.some(
    (window) => minuteOfDay >= window.start && minuteOfDay < window.end,
  );
}

export function rateClassForInstant(date: Date): RateClass {
  return isPeakInstant(date) ? "peak" : "off-peak";
}

export interface RateWindow {
  readonly rateClass: RateClass;
  readonly peakShare: number;
  readonly offPeakShare: number;
}

// Classifies [startedAt, finishedAt) minute by minute; peak windows are aligned
// to minute boundaries, so walking minute slots gives the exact elapsed-time
// split at millisecond precision. An empty or inverted window falls back to the
// class of its start instant.
export function splitWindowByRateClass(startedAt: Date, finishedAt: Date): RateWindow {
  const startMs = startedAt.getTime();
  const endMs = finishedAt.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    const instantClass = rateClassForInstant(startedAt);
    return {
      rateClass: instantClass,
      peakShare: instantClass === "peak" ? 1 : 0,
      offPeakShare: instantClass === "peak" ? 0 : 1,
    };
  }

  let peakMs = 0;
  let offPeakMs = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const slotEnd = Math.min((Math.floor(cursor / MINUTE_MS) + 1) * MINUTE_MS, endMs);
    if (isPeakInstant(new Date(cursor))) {
      peakMs += slotEnd - cursor;
    } else {
      offPeakMs += slotEnd - cursor;
    }
    cursor = slotEnd;
  }

  const totalMs = peakMs + offPeakMs;
  const peakShare = peakMs / totalMs;
  const rateClass: RateClass = peakMs === 0 ? "off-peak" : offPeakMs === 0 ? "peak" : "mixed";
  return { rateClass, peakShare, offPeakShare: 1 - peakShare };
}

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

/**
 * Cache-excluded, like-for-like token triple (#89): `in` is cache-miss input,
 * `out` is output (reasoning included), and `total = in + out`. This is the
 * report's comparison view; cache-hit input is deliberately excluded.
 */
export interface BillableTokens {
  readonly in: number;
  readonly out: number;
  readonly total: number;
}

/** Cache-excluded triple from raw buckets, via `normalizeBuckets` (#89). */
export function billableTokens(buckets: TokenBuckets, side: BenchmarkSide): BillableTokens {
  const { miss, output } = normalizeBuckets(buckets, side);
  return { in: miss, out: output, total: miss + output };
}

/** Cost in USD of one bucket set at one rate card. */
export function costAtRates(buckets: TokenBuckets, side: BenchmarkSide, rates: RateCard): number {
  const { miss, hit, output } = normalizeBuckets(buckets, side);
  return (
    (miss * rates.cacheMissInputPerMillion +
      hit * rates.cacheHitInputPerMillion +
      output * rates.outputPerMillion) /
    1_000_000
  );
}

export interface RunCost {
  readonly cost: number;
  readonly rateClass: RateClass;
  /** Elapsed-time share of the window spent in peak hours (0..1). */
  readonly peakShare: number;
}

/** USD cost of one run: buckets priced across the run's actual time window. */
export function runCost(
  buckets: TokenBuckets,
  side: BenchmarkSide,
  startedAt: Date,
  finishedAt: Date,
): RunCost {
  const split = splitWindowByRateClass(startedAt, finishedAt);
  const cost =
    split.peakShare * costAtRates(buckets, side, PEAK_RATES_PER_MILLION) +
    split.offPeakShare * costAtRates(buckets, side, OFF_PEAK_RATES_PER_MILLION);
  return { cost, rateClass: split.rateClass, peakShare: split.peakShare };
}
