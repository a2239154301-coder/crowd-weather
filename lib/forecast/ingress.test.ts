import { describe, expect, it } from "vitest";
import { simulateIngress } from "./ingress";
import type { IngressResult } from "./ingress";

/**
 * 入場ピークモデルの仕様固定テスト。人数保存則・決定性という物理モデルとしての
 * 土台に加え、既定値（tickets=24,000）でのピーク時刻・待ち時間を数字で固定する。
 */

const GATES = ["west", "east"] as const;

function sumArrivals(r: IngressResult, gate: (typeof GATES)[number]): number {
  return r.byGate[gate].reduce((s, row) => s + row.arrivals, 0);
}
function sumProcessed(r: IngressResult, gate: (typeof GATES)[number]): number {
  return r.byGate[gate].reduce((s, row) => s + row.processed, 0);
}
function lastQueueEnd(r: IngressResult, gate: (typeof GATES)[number]): number {
  const rows = r.byGate[gate];
  return rows[rows.length - 1].queueEnd;
}

describe("simulateIngress", () => {
  it("人数保存: 各ゲートで Σarrivals = Σprocessed + 最終時刻のqueueEnd", () => {
    const r = simulateIngress(24000);
    for (const gate of GATES) {
      expect(sumArrivals(r, gate), gate).toBeCloseTo(
        sumProcessed(r, gate) + lastQueueEnd(r, gate),
        6,
      );
    }
  });

  it("決定性: 同一入力なら同一出力", () => {
    const a = simulateIngress(24000);
    const b = simulateIngress(24000);
    expect(a).toEqual(b);
  });

  it("tickets=0 で全ゼロ・maxWaitMin 0", () => {
    const r = simulateIngress(0);
    expect(r.totalArrivals).toBe(0);
    expect(r.maxWaitMin).toBe(0);
    for (const gate of GATES) {
      for (const row of r.byGate[gate]) {
        expect(row.arrivals).toBe(0);
        expect(row.processed).toBe(0);
        expect(row.queueEnd).toBe(0);
        expect(row.waitMin).toBe(0);
      }
    }
  });

  it("負・NaN・Infinity の tickets は throw", () => {
    expect(() => simulateIngress(-1)).toThrow();
    expect(() => simulateIngress(NaN)).toThrow();
    expect(() => simulateIngress(Infinity)).toThrow();
    expect(() => simulateIngress(-Infinity)).toThrow();
  });

  it("既定値・tickets=24,000: peakHour=12、maxWaitMinは20〜50分の範囲", () => {
    const r = simulateIngress(24000);
    expect(r.peakHour).toBe(12);
    expect(r.maxWaitMin).toBeGreaterThanOrEqual(20);
    expect(r.maxWaitMin).toBeLessThanOrEqual(50);
    // 実測: 38.2分（west・13:00台）。
    //
    // 設計メモとの差分: 実装前の見積もりでは「12時Δが最大到着なのでmaxWaitHourも12時」
    // と見込んでいたが、実測は13:00台がピーク。理由は到着ピーク（12時Δ=0.22）と
    // 行列ピーク（queueEndが積み上がり続ける時間帯）が別概念だから:
    //   11時: 到着2400 > 容量1980 → 繰越+420
    //   12時: 到着2640 > 容量1980 → 繰越+660 (計1080)
    //   13時: 到着2160 > 容量1980 → 繰越+180 (計1260) ← ここが山
    //   14時: 到着1800 < 容量1980 → 繰越-180 (計1080、以降減少)
    // 13時のΔ(0.18)はまだ容量を上回っており、行列は12時→13時でも増え続ける。
    // 「到着数が最大の時間帯」と「行列が最大になる時間帯」は待ち行列モデルでは
    // 一般に一致しない（到着が容量を下回るまで行列は積み上がり続ける）。
    // peakHour（到着基準の定義どおり12）とmaxWaitHour（行列基準・実測13）は
    // 別の量として両方を固定する。
    expect(r.maxWaitMin).toBeCloseTo(38.2, 1);
    expect(r.maxWaitGate).toBe("west");
    expect(r.maxWaitHour).toBe(13);
  });

  it("容量を十分大きくすると全時間帯 waitMin 0", () => {
    const r = simulateIngress(24000, { lanesPerGate: 50 });
    expect(r.maxWaitMin).toBe(0);
    for (const gate of GATES) {
      for (const row of r.byGate[gate]) expect(row.waitMin).toBe(0);
    }
  });

  it("splitWest: 0.7 にすると west の待ちが east より大きい", () => {
    const r = simulateIngress(24000, { splitWest: 0.7 });
    const maxOf = (gate: (typeof GATES)[number]) =>
      Math.max(...r.byGate[gate].map((row) => row.waitMin));
    expect(maxOf("west")).toBeGreaterThan(maxOf("east"));
  });

  it("assumptions は既定値を返し、opts で部分上書きできる", () => {
    const r = simulateIngress(24000);
    expect(r.assumptions).toEqual({ lanesPerGate: 3, personsPerLaneMin: 11, splitWest: 0.5 });
    const r2 = simulateIngress(24000, { lanesPerGate: 5 });
    expect(r2.assumptions).toEqual({ lanesPerGate: 5, personsPerLaneMin: 11, splitWest: 0.5 });
  });

  it("不正な assumptions（0以下のレーン数・範囲外のsplitWest）は throw", () => {
    expect(() => simulateIngress(24000, { lanesPerGate: 0 })).toThrow();
    expect(() => simulateIngress(24000, { personsPerLaneMin: -1 })).toThrow();
    expect(() => simulateIngress(24000, { splitWest: 1.5 })).toThrow();
    expect(() => simulateIngress(24000, { splitWest: -0.1 })).toThrow();
  });

  it("全ゲートの時系列が11〜21時で揃い、負値がない", () => {
    const r = simulateIngress(12000);
    for (const gate of GATES) {
      expect(r.byGate[gate].map((row) => row.hour)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      ]);
      for (const row of r.byGate[gate]) {
        expect(row.arrivals).toBeGreaterThanOrEqual(0);
        expect(row.processed).toBeGreaterThanOrEqual(0);
        expect(row.queueEnd).toBeGreaterThanOrEqual(0);
        expect(row.waitMin).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
