import { describe, expect, test } from "bun:test";
import {
  PEAK_RATES_PER_MILLION,
  PRICING_FETCHED_ON,
  billableCost,
  billableCostAtRates,
  billableCostForLoopTokens,
  costAtRates,
  normalizeBuckets,
  peakCost,
} from "./pricing";
import type { TokenBuckets } from "./pricing";

function buckets(overrides: Partial<TokenBuckets> = {}): TokenBuckets {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    ...overrides,
  };
}

describe("rate table", () => {
  test("official peak USD-per-1M values", () => {
    expect(PEAK_RATES_PER_MILLION).toEqual({
      cacheHitInputPerMillion: 0.006,
      cacheMissInputPerMillion: 0.3,
      outputPerMillion: 1.2,
    });
    expect(PRICING_FETCHED_ON).toBe("2026-10-27");
  });
});

describe("bucket normalization", () => {
  test("tc input includes cache hits", () => {
    const normalized = normalizeBuckets(
      buckets({ input: 3073, cacheRead: 2816, output: 1613, reasoning: 0 }),
      "tc",
    );
    expect(normalized).toEqual({ miss: 257, hit: 2816, output: 1613 });
  });

  test("oc input excludes cache hits", () => {
    const normalized = normalizeBuckets(
      buckets({ input: 9345, cacheRead: 22400, output: 2160, reasoning: 0 }),
      "oc",
    );
    expect(normalized).toEqual({ miss: 9345, hit: 22400, output: 2160 });
  });

  test("output prices reasoning together with output", () => {
    const normalized = normalizeBuckets(buckets({ input: 10, output: 5, reasoning: 3 }), "oc");
    expect(normalized.output).toBe(8);
  });

  test("cacheWrite is priced at the miss rate on both sides", () => {
    expect(
      normalizeBuckets(buckets({ input: 100, cacheRead: 40, cacheWrite: 10 }), "tc").miss,
    ).toBe(70);
    expect(normalizeBuckets(buckets({ input: 100, cacheWrite: 10 }), "oc").miss).toBe(110);
  });

  test("missing buckets count as zero and tc misses clamp at zero", () => {
    expect(normalizeBuckets(buckets(), "oc")).toEqual({ miss: 0, hit: 0, output: 0 });
    expect(normalizeBuckets(buckets({ input: 10, cacheRead: 30 }), "tc").miss).toBe(0);
  });
});

describe("cost computation", () => {
  const OC_JSON_REP1 = buckets({ input: 9345, output: 2160, cacheRead: 22400, reasoning: 0 });
  const TC_JSON_REP1 = buckets({ input: 257 + 2816, output: 1613, cacheRead: 2816, reasoning: 0 });

  test("oc json rep1 full peak cost doubles the old off-peak cost", () => {
    const cost = costAtRates(OC_JSON_REP1, "oc");
    expect(cost).toBeCloseTo(0.0055299, 10);
    expect(peakCost(OC_JSON_REP1, "oc")).toBeCloseTo(cost, 12);
  });

  test("tc json rep1 full peak cost doubles the old off-peak cost", () => {
    expect(costAtRates(TC_JSON_REP1, "tc")).toBeCloseTo(0.002029596, 10);
  });

  test("billable cost excludes cache-hit input", () => {
    const oc = billableCost(OC_JSON_REP1, "oc");
    expect(oc.in).toBeCloseTo(0.0028035, 12);
    expect(oc.out).toBeCloseTo(0.002592, 12);
    expect(oc.total).toBeCloseTo(0.0053955, 12);

    const tc = billableCost(TC_JSON_REP1, "tc");
    expect(tc.in).toBeCloseTo(0.0000771, 12);
    expect(tc.out).toBeCloseTo(0.0019356, 12);
    expect(tc.total).toBeCloseTo(0.0020127, 12);
  });

  test("billable cost prices cacheWrite as miss and reasoning as output", () => {
    const cost = billableCostAtRates(
      buckets({ input: 100, cacheRead: 40, cacheWrite: 10, output: 5, reasoning: 3 }),
      "tc",
    );
    // miss = (100 - 40) + 10 = 70; output = 5 + 3 = 8.
    expect(cost.in).toBeCloseTo((70 * 0.3) / 1_000_000, 12);
    expect(cost.out).toBeCloseTo((8 * 1.2) / 1_000_000, 12);
    expect(cost.total).toBeCloseTo((70 * 0.3 + 8 * 1.2) / 1_000_000, 12);
  });

  test("loop USD cost budget uses tc buckets and peak rates", () => {
    expect(
      billableCostForLoopTokens({ input: 500, output: 20, cacheRead: 400, reasoning: 30 }),
    ).toBeCloseTo(0.00009, 12);
  });

  test("empty buckets cost zero", () => {
    expect(costAtRates(buckets(), "tc")).toBe(0);
    expect(billableCost(buckets(), "oc")).toEqual({ in: 0, out: 0, total: 0 });
  });
});
