import { describe, expect, it } from "vitest";
import { simulateEgress, defaultEgress, regulatedEgress } from "./egress";
import type { EgressParams, EgressResult } from "./egress";

/**
 * 退場波及モデルの仕様固定テスト。
 * 「規制退場は下流のピークを下げる」という製品の主張そのものを数字で固定し、
 * 併せて人数保存則・決定性という物理モデルとしての土台を守る。
 */

// egress.ts のネットワーク定義の写し（仕様の一部としてここに固定する）
const IN_SYSTEM = ["main", "exit", "plaza", "conc"] as const;
const ABSORBING = ["plat", "alley", "blvd", "bus"] as const;
const ALL_NODES = [...IN_SYSTEM, ...ABSORBING];

/** 分 t までに放出済みの人数 */
function releasedThrough(params: EgressParams, t: number): number {
  return (
    params.attendees *
    params.releaseWaves.filter((w) => w.atMin <= t).reduce((s, w) => s + w.fraction, 0)
  );
}

/** 分 t の系内滞留（吸収ノード以外の合計） */
function inSystemAt(r: EgressResult, t: number): number {
  return IN_SYSTEM.reduce((s, n) => s + r.series[n][t], 0);
}

/** 分 t までの系外流出累計（吸収ノードの series は「その分の流入」なので累積する） */
function absorbedThrough(r: EgressResult, t: number): number {
  return ABSORBING.reduce(
    (s, n) => s + r.series[n].slice(0, t + 1).reduce((a, v) => a + v, 0),
    0,
  );
}

describe("simulateEgress", () => {
  it("人数保存則: 放出済み合計 = 系内滞留 + 系外流出累計（一斉退場・複数時点）", () => {
    const params = defaultEgress(20000); // attendees = 11000
    const r = simulateEgress(params);
    for (const t of [0, 3, 7, 12, r.clearMin]) {
      expect(inSystemAt(r, t) + absorbedThrough(r, t), `t=${t}`).toBeCloseTo(
        releasedThrough(params, t),
        6,
      );
    }
  });

  it("人数保存則: 規制退場でも波の合間・途中で成り立つ", () => {
    const params = regulatedEgress(20000);
    const r = simulateEgress(params);
    // 5=第1波のはけ際, 12=第2波の最中, 21=第3波の直後, clearMin=最終
    for (const t of [0, 5, 12, 21, r.clearMin]) {
      expect(inSystemAt(r, t) + absorbedThrough(r, t), `t=${t}`).toBeCloseTo(
        releasedThrough(params, t),
        6,
      );
    }
  });

  it("同じ入力なら毎回同じ結果（決定的）", () => {
    const a = simulateEgress(regulatedEgress(20000));
    const b = simulateEgress(regulatedEgress(20000));
    expect(a).toEqual(b);
  });

  it("規制退場は一斉退場より plaza と conc のピークが低い（製品の主張そのもの）", () => {
    // tickets=5000（中規模イベント）を選ぶ理由:
    // 規制退場の1波 = 2750/3 ≈ 917人。この規模なら exit の滞留が
    // exit→plaza エッジ（14m = 840人/分）を飽和させず、ピーク低減が
    // 厳密な不等号で現れる。大規模で plaza が容量律速になるケースは次のテスト
    const def = simulateEgress(defaultEgress(5000));
    const reg = simulateEgress(regulatedEgress(5000));
    expect(reg.peak.plaza.value).toBeLessThan(def.peak.plaza.value);
    expect(reg.peak.conc.value).toBeLessThan(def.peak.conc.value);
  });

  it("大規模（tickets=20000）では plaza は容量律速で同値だが conc は下がる", () => {
    // exit→plaza の容量840人/分が両シナリオで飽和するため、plaza のピークは
    // どちらも 840 で頭打ちになる（規制退場でも増えはしない）。
    // 一方 conc は流入504人/分 > 流出480人/分で滞留が積み上がるノードなので、
    // 波を分けて積み上げ時間を短くする効果が大規模でも残る
    const def = simulateEgress(defaultEgress(20000));
    const reg = simulateEgress(regulatedEgress(20000));
    expect(def.peak.plaza.value).toBeCloseTo(840, 6);
    expect(reg.peak.plaza.value).toBeLessThanOrEqual(def.peak.plaza.value);
    expect(reg.peak.conc.value).toBeLessThan(def.peak.conc.value);
  });

  it("規制退場の clearMin は一斉退場と同等かやや遅い（ただしピークは下がる）", () => {
    const def = simulateEgress(defaultEgress(5000));
    const reg = simulateEgress(regulatedEgress(5000));
    // トレードオフの両面を1つのテストで固定する
    expect(reg.clearMin).toBeGreaterThanOrEqual(def.clearMin);
    expect(reg.peak.conc.value).toBeLessThan(def.peak.conc.value);
  });

  it("全員がいずれ系外へ出る（clearMin が有限＝240分以内）", () => {
    for (const params of [defaultEgress(20000), regulatedEgress(20000)]) {
      const r = simulateEgress(params);
      expect(Number.isFinite(r.clearMin)).toBe(true);
      expect(r.clearMin).toBeLessThanOrEqual(240);
      // はけた時点で 99% 以上が系外へ出ている
      expect(absorbedThrough(r, r.clearMin)).toBeGreaterThanOrEqual(params.attendees * 0.99);
    }
  });

  it("fraction 合計が1でない入力はエラー", () => {
    expect(() =>
      simulateEgress({ attendees: 1000, releaseWaves: [{ atMin: 0, fraction: 0.5 }] }),
    ).toThrow();
    expect(() =>
      simulateEgress({
        attendees: 1000,
        releaseWaves: [
          { atMin: 0, fraction: 0.6 },
          { atMin: 5, fraction: 0.6 },
        ],
      }),
    ).toThrow();
    // 1/3 × 3 の浮動小数の和は「1」と認める（許容誤差内）
    expect(() => simulateEgress(regulatedEgress(9000))).not.toThrow();
  });

  it("吸収ノードの series は「その分の流入」を記録する（ピーク観察用）", () => {
    // 一斉退場で exit が飽和している間、バスへは 0.15 × 1200 = 180人/分 が流れる。
    // 吸収ノードに滞留が積み上がらず、流入がそのまま見えることの固定
    const r = simulateEgress(defaultEgress(20000));
    expect(r.peak.bus.value).toBeCloseTo(180, 6);
    // 初分は main→exit しか動いていないので、吸収ノードの流入は 0
    expect(r.series.plat[0]).toBe(0);
    expect(r.series.bus[0]).toBe(0);
  });

  it("全8ノードの series が揃い、長さが等しく、負値がない", () => {
    const r = simulateEgress(regulatedEgress(12000));
    const len = r.clearMin + 1; // はけた分まで記録して打ち切る
    for (const n of ALL_NODES) {
      expect(r.series[n], n).toBeDefined();
      expect(r.series[n].length, n).toBe(len);
      for (const v of r.series[n]) expect(v).toBeGreaterThanOrEqual(0);
      expect(r.peak[n].value).toBeGreaterThanOrEqual(0);
      expect(r.peak[n].atMin).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("defaultEgress / regulatedEgress", () => {
  it("attendees = round(tickets × 0.55)（終演時在場率 = model.ts の OCCUPANCY[21]）", () => {
    expect(defaultEgress(20000).attendees).toBe(11000);
    expect(regulatedEgress(20000).attendees).toBe(11000);
    expect(defaultEgress(4321).attendees).toBe(Math.round(4321 * 0.55));
  });

  it("一斉退場は1波、規制退場は10分間隔の3波", () => {
    expect(defaultEgress(1000).releaseWaves).toEqual([{ atMin: 0, fraction: 1 }]);
    const waves = regulatedEgress(1000).releaseWaves;
    expect(waves.map((w) => w.atMin)).toEqual([0, 10, 20]);
    expect(waves.reduce((s, w) => s + w.fraction, 0)).toBeCloseTo(1, 9);
  });
});
