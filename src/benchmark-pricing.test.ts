import { describe, expect, test } from "bun:test";
import {
  CN_2026_PUBLIC_HOLIDAYS,
  OFF_PEAK_RATES_PER_MILLION,
  PEAK_RATES_PER_MILLION,
  costAtRates,
  isChineseHoliday,
  isPeakInstant,
  normalizeBuckets,
  rateClassForInstant,
  runCost,
  splitWindowByRateClass,
} from "./benchmark-pricing";
import type { TokenBuckets } from "./benchmark-pricing";

// 2026-10-14 is a Wednesday; 2026-10-17/18 a weekend; 2026-10-01 is a Chinese
// public holiday (Thursday).
const WEDNESDAY = "2026-10-14";

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
  test("off-peak is half of peak on every rate", () => {
    expect(OFF_PEAK_RATES_PER_MILLION.cacheHitInputPerMillion).toBe(
      PEAK_RATES_PER_MILLION.cacheHitInputPerMillion / 2,
    );
    expect(OFF_PEAK_RATES_PER_MILLION.cacheMissInputPerMillion).toBe(
      PEAK_RATES_PER_MILLION.cacheMissInputPerMillion / 2,
    );
    expect(OFF_PEAK_RATES_PER_MILLION.outputPerMillion).toBe(
      PEAK_RATES_PER_MILLION.outputPerMillion / 2,
    );
  });

  test("official USD-per-1M values", () => {
    expect(PEAK_RATES_PER_MILLION).toEqual({
      cacheHitInputPerMillion: 0.006,
      cacheMissInputPerMillion: 0.3,
      outputPerMillion: 1.2,
    });
    expect(OFF_PEAK_RATES_PER_MILLION).toEqual({
      cacheHitInputPerMillion: 0.003,
      cacheMissInputPerMillion: 0.15,
      outputPerMillion: 0.6,
    });
  });

  test("2026 holiday list covers the official date ranges", () => {
    expect(CN_2026_PUBLIC_HOLIDAYS.length).toBe(33);
    expect(isChineseHoliday(new Date("2026-01-01T12:00:00Z"))).toBe(true);
    expect(isChineseHoliday(new Date("2026-10-07T12:00:00Z"))).toBe(true);
    expect(isChineseHoliday(new Date("2026-10-08T12:00:00Z"))).toBe(false);
    expect(isChineseHoliday(new Date("2026-02-14T12:00:00Z"))).toBe(false);
  });
});

describe("peak/off-peak instants", () => {
  test("weekday peak window boundaries", () => {
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T00:59:59.999Z`))).toBe("off-peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T01:00:00.000Z`))).toBe("peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T03:59:59.999Z`))).toBe("peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T04:00:00.000Z`))).toBe("off-peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T05:59:59.999Z`))).toBe("off-peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T06:00:00.000Z`))).toBe("peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T09:59:59.999Z`))).toBe("peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T10:00:00.000Z`))).toBe("off-peak");
    expect(rateClassForInstant(new Date(`${WEDNESDAY}T23:30:00.000Z`))).toBe("off-peak");
  });

  test("weekends are off-peak all day", () => {
    expect(rateClassForInstant(new Date("2026-10-17T02:00:00Z"))).toBe("off-peak");
    expect(rateClassForInstant(new Date("2026-10-18T07:00:00Z"))).toBe("off-peak");
    expect(rateClassForInstant(new Date("2026-10-19T07:00:00Z"))).toBe("peak");
  });

  test("Chinese public holidays are off-peak even on weekdays", () => {
    expect(rateClassForInstant(new Date("2026-10-01T07:00:00Z"))).toBe("off-peak");
    expect(rateClassForInstant(new Date("2026-10-02T02:00:00Z"))).toBe("off-peak");
    expect(rateClassForInstant(new Date("2026-10-07T07:00:00Z"))).toBe("off-peak");
    expect(rateClassForInstant(new Date("2026-10-08T07:00:00Z"))).toBe("peak");
    expect(rateClassForInstant(new Date("2026-05-04T07:00:00Z"))).toBe("off-peak");
    expect(rateClassForInstant(new Date("2026-05-06T07:00:00Z"))).toBe("peak");
    expect(rateClassForInstant(new Date("2026-09-24T07:00:00Z"))).toBe("peak");
    expect(rateClassForInstant(new Date("2026-09-28T07:00:00Z"))).toBe("peak");
  });
});

describe("window splitting", () => {
  test("a window fully inside peak hours is peak", () => {
    const split = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T06:30:00Z`),
      new Date(`${WEDNESDAY}T07:00:00Z`),
    );
    expect(split.rateClass).toBe("peak");
    expect(split.peakShare).toBe(1);
    expect(split.offPeakShare).toBe(0);
  });

  test("a window fully outside peak hours is off-peak", () => {
    const split = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T05:00:00Z`),
      new Date(`${WEDNESDAY}T05:30:00Z`),
    );
    expect(split.rateClass).toBe("off-peak");
    expect(split.peakShare).toBe(0);
    expect(split.offPeakShare).toBe(1);
  });

  test("a window straddling the 10:00 boundary splits 50/50", () => {
    const split = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T09:45:00Z`),
      new Date(`${WEDNESDAY}T10:15:00Z`),
    );
    expect(split.rateClass).toBe("mixed");
    expect(split.peakShare).toBeCloseTo(0.5, 12);
    expect(split.offPeakShare).toBeCloseTo(0.5, 12);
  });

  test("a window straddling the 01:00 boundary splits 30/60", () => {
    const split = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T00:30:00Z`),
      new Date(`${WEDNESDAY}T01:30:00Z`),
    );
    expect(split.rateClass).toBe("mixed");
    expect(split.peakShare).toBeCloseTo(0.5, 12);
  });

  test("millisecond precision at a boundary", () => {
    const split = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T09:59:30.000Z`),
      new Date(`${WEDNESDAY}T10:00:30.000Z`),
    );
    expect(split.rateClass).toBe("mixed");
    expect(split.peakShare).toBeCloseTo(0.5, 12);
  });

  test("a full weekday has 7 peak hours of 24", () => {
    const split = splitWindowByRateClass(
      new Date("2026-10-19T00:00:00Z"),
      new Date("2026-10-20T00:00:00Z"),
    );
    expect(split.rateClass).toBe("mixed");
    expect(split.peakShare).toBeCloseTo(420 / 1440, 12);
  });

  test("a holiday weekday and a weekend are fully off-peak", () => {
    const holiday = splitWindowByRateClass(
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-02T00:00:00Z"),
    );
    expect(holiday.rateClass).toBe("off-peak");
    const weekend = splitWindowByRateClass(
      new Date("2026-10-17T00:00:00Z"),
      new Date("2026-10-19T00:00:00Z"),
    );
    expect(weekend.rateClass).toBe("off-peak");
  });

  test("empty and inverted windows fall back to the start instant's class", () => {
    const emptyPeak = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T07:00:00Z`),
      new Date(`${WEDNESDAY}T07:00:00Z`),
    );
    expect(emptyPeak.rateClass).toBe("peak");
    expect(emptyPeak.peakShare).toBe(1);
    const inverted = splitWindowByRateClass(
      new Date(`${WEDNESDAY}T11:00:00Z`),
      new Date(`${WEDNESDAY}T10:00:00Z`),
    );
    expect(inverted.rateClass).toBe("off-peak");
    expect(inverted.offPeakShare).toBe(1);
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
  // Verification fixtures from #63: the oc session-export JSON rep1 and the tc
  // JSON rep1 example.
  const OC_JSON_REP1 = buckets({ input: 9345, output: 2160, cacheRead: 22400, reasoning: 0 });
  const TC_JSON_REP1 = buckets({ input: 257 + 2816, output: 1613, cacheRead: 2816, reasoning: 0 });

  test("oc json rep1 off-peak equals the export's own cost", () => {
    const cost = costAtRates(OC_JSON_REP1, "oc", OFF_PEAK_RATES_PER_MILLION);
    expect(cost).toBeCloseTo(0.00276495, 10);
    const exportCost = 0.0027649499999999995;
    expect(Math.abs(cost - exportCost) / exportCost).toBeLessThan(1e-9);
  });

  test("oc json rep1 peak doubles the off-peak cost", () => {
    const offPeak = costAtRates(OC_JSON_REP1, "oc", OFF_PEAK_RATES_PER_MILLION);
    const peak = costAtRates(OC_JSON_REP1, "oc", PEAK_RATES_PER_MILLION);
    expect(peak).toBeCloseTo(offPeak * 2, 12);
  });

  test("tc json rep1 example costs $0.0010148 off-peak", () => {
    // Exact value 0.001014798; the issue reports it rounded to 0.0010148.
    expect(costAtRates(TC_JSON_REP1, "tc", OFF_PEAK_RATES_PER_MILLION)).toBeCloseTo(0.0010148, 8);
  });

  test("runCost uses the run's window class", () => {
    const result = runCost(
      OC_JSON_REP1,
      "oc",
      new Date("2026-10-18T22:03:54Z"),
      new Date("2026-10-18T22:04:17Z"),
    );
    expect(result.rateClass).toBe("off-peak");
    expect(result.peakShare).toBe(0);
    expect(result.cost).toBeCloseTo(0.00276495, 10);
  });

  test("runCost blends straddling windows by elapsed-time share", () => {
    const result = runCost(
      OC_JSON_REP1,
      "oc",
      new Date(`${WEDNESDAY}T09:45:00Z`),
      new Date(`${WEDNESDAY}T10:15:00Z`),
    );
    expect(result.rateClass).toBe("mixed");
    expect(result.peakShare).toBeCloseTo(0.5, 12);
    expect(result.cost).toBeCloseTo(0.00276495 * 1.5, 12);
  });
});
