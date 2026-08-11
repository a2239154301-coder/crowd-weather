import { describe, expect, it } from "vitest";
import { tentPlan, TENT } from "./tent";

/**
 * テント配置提案（馬場v4移植）の仕様固定テスト。
 * 判定条件: WBGT28以上 かつ 日陰率60%未満の待機ゾーンに、
 * ceil(queueArea × (1-日陰率) / 18m²) 枚を提案する。
 */

const zones = [
  { id: "wg", name: "西ゲート", queueArea: 180 },
  { id: "aid", name: "救護・給水", queueArea: 100 },
];

describe("tentPlan", () => {
  it("暑くて日陰がないゾーンにだけ提案する", () => {
    const steps = [
      {
        minutes: 720,
        night: false,
        zones: [
          { id: "wg", shade: 0.1, wbgt: 31 }, // 対象
          { id: "aid", shade: 0.9, wbgt: 31 }, // 日陰が足りている → 対象外
        ],
      },
    ];
    const r = tentPlan(steps, zones);
    expect(r.list).toHaveLength(1);
    expect(r.list[0].zone.id).toBe("wg");
    // ceil(180 × 0.9 / 18) = 9
    expect(r.list[0].need).toBe(9);
    expect(r.total).toBe(9);
  });

  it("WBGT28未満なら提案しない", () => {
    const steps = [
      { minutes: 720, night: false, zones: [{ id: "wg", shade: 0.0, wbgt: 27.9 }] },
    ];
    expect(tentPlan(steps, [zones[0]]).total).toBe(0);
  });

  it("夜のステップは無視する", () => {
    const steps = [
      { minutes: 1260, night: true, zones: [{ id: "wg", shade: 0.0, wbgt: 35 }] },
    ];
    expect(tentPlan(steps, [zones[0]]).total).toBe(0);
  });

  it("from/to は該当時間帯の端＋30分（原本仕様）", () => {
    const mk = (m: number, wbgt: number) => ({
      minutes: m,
      night: false,
      zones: [{ id: "wg", shade: 0.2, wbgt }],
    });
    const r = tentPlan([mk(720, 26), mk(750, 29), mk(780, 30), mk(810, 26)], [zones[0]]);
    expect(r.list[0].from).toBe(750);
    expect(r.list[0].to).toBe(810); // 780 + 30
  });

  it("テント1枚は 3×6m = 18m²", () => {
    expect(TENT).toBe(18);
  });
});
