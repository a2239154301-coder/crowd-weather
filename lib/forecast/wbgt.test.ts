import { describe, expect, it } from "vitest";
import { irradiance, wetBulbStull, wbgtPhysical } from "./wbgt";

/**
 * WBGT物理チェーンの回帰テスト。
 *
 * ゴールデン値は 2026-08-11 の移植検証時（scripts/verify-wbgt.mjs・
 * 馬場v4原本と82アサーション一致を確認済み）の実装から採取した。
 * これらが変わったら「物理式を変えた」ということ。意図的な変更のとき以外は失敗が正しい。
 */

describe("wetBulbStull (Stull 2011)", () => {
  it("34℃・60% → 27.59℃", () => {
    expect(wetBulbStull(34, 60)).toBeCloseTo(27.58974, 4);
  });
  it("湿度100%に近いほど気温に近づく", () => {
    expect(wetBulbStull(30, 99)).toBeGreaterThan(wetBulbStull(30, 50));
    expect(wetBulbStull(30, 99)).toBeLessThanOrEqual(30);
  });
});

describe("irradiance (Kasten-Young)", () => {
  it("晴天・高度60°の直達+散乱", () => {
    const r = irradiance(60, "sunny");
    expect(r.dir).toBeCloseTo(799.0986, 3);
    expect(r.dif).toBeCloseTo(115.4275, 3);
  });
  it("夜（高度0以下）はゼロ", () => {
    expect(irradiance(0, "sunny")).toEqual({ dir: 0, dif: 0 });
  });
  it("雨は直達がほぼ消える", () => {
    const sunny = irradiance(45, "sunny");
    const rainy = irradiance(45, "rainy");
    expect(rainy.dir).toBeLessThan(sunny.dir * 0.05);
  });
});

describe("wbgtPhysical", () => {
  const env = (weather: "sunny" | "cloudy" | "rainy", taC: number, rhPct: number, windMs: number) => ({
    weather,
    taC,
    rhPct,
    windMs,
  });

  it.each([
    // [shadeFrac, altDeg, env..., 期待wbgt] — 移植検証時のゴールデン値
    [0.08, 60, env("sunny", 34, 60, 1.5), 33.327672],
    [0.85, 60, env("sunny", 34, 60, 1.5), 30.417509],
    [0.08, 30, env("cloudy", 34, 80, 0.5), 33.369506],
    [1.0, 5, env("rainy", 25, 70, 3), 22.218659],
  ])("ゴールデン値: shade=%f alt=%f", (shade, alt, e, expected) => {
    expect(wbgtPhysical(shade as number, alt as number, e as never).wbgt).toBeCloseTo(
      expected as number,
      5
    );
  });

  it("日陰は日向よりWBGTが低い（他条件同一）", () => {
    const e = env("sunny", 34, 60, 1.5);
    expect(wbgtPhysical(1, 60, e).wbgt).toBeLessThan(wbgtPhysical(0, 60, e).wbgt);
  });

  it("風が強いほどWBGTが下がる（対流冷却）", () => {
    const calm = wbgtPhysical(0, 60, env("sunny", 34, 60, 0.2));
    const windy = wbgtPhysical(0, 60, env("sunny", 34, 60, 5));
    expect(windy.wbgt).toBeLessThan(calm.wbgt);
  });

  it("湿度が高いほどWBGTが上がる", () => {
    const dry = wbgtPhysical(0, 60, env("sunny", 34, 40, 1.5));
    const humid = wbgtPhysical(0, 60, env("sunny", 34, 90, 1.5));
    expect(humid.wbgt).toBeGreaterThan(dry.wbgt);
  });
});
