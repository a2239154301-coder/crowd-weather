import { describe, expect, it } from "vitest";
import { findRoute, destinationsFor, anchorOf } from "./route";
import { zonesFor, DEFAULT_SCENARIO } from "./venue";

/**
 * 経路探索の仕様固定テスト。
 * 「安全に関わる案内で毎回違う答えが返らない」ことが要件なので、
 * 決定性と、preference が実際に経路の性質を変えることを確かめる。
 */

const zones = zonesFor("in");
const S = DEFAULT_SCENARIO;

describe("findRoute", () => {
  it("会場内の任意のゾーンから救護・給水へ到達できる", () => {
    const dests = destinationsFor(zones);
    expect(dests.length).toBeGreaterThan(0);
    const r = findRoute(zones, "wg", dests[0].zone.id, 15, S, "safe");
    expect(r).not.toBeNull();
    expect(r!.steps[0].zone.id).toBe("wg");
    expect(r!.steps[r!.steps.length - 1].zone.id).toBe(dests[0].zone.id);
    expect(r!.meters).toBeGreaterThan(0);
    expect(r!.minutes).toBeGreaterThanOrEqual(1);
  });

  it("同じ入力なら毎回同じ経路（決定的）", () => {
    const a = findRoute(zones, "wg", "aid", 15, S, "safe");
    const b = findRoute(zones, "wg", "aid", 15, S, "safe");
    expect(a!.steps.map((s) => s.zone.id)).toEqual(b!.steps.map((s) => s.zone.id));
  });

  it("出発地と目的地が同じなら1ステップ・0m", () => {
    const r = findRoute(zones, "aid", "aid", 15, S, "safe");
    expect(r!.steps).toHaveLength(1);
    expect(r!.meters).toBe(0);
  });

  it("safe は short より混雑を避ける（最大混雑が増えない）", () => {
    const short = findRoute(zones, "wg", "aid", 16, S, "short");
    const safe = findRoute(zones, "wg", "aid", 16, S, "safe");
    expect(safe!.maxDensity).toBeLessThanOrEqual(short!.maxDensity);
  });

  it("cool は short より日陰を通る（日陰率が下がらない）", () => {
    const short = findRoute(zones, "wg", "aid", 13, S, "short");
    const cool = findRoute(zones, "wg", "aid", 13, S, "cool");
    expect(cool!.shadeRatio).toBeGreaterThanOrEqual(short!.shadeRatio);
  });

  it("存在しないゾーンIDには経路を返さない", () => {
    expect(findRoute(zones, "wg", "no-such-zone", 15, S, "safe")).toBeNull();
  });

  it("屋内ゾーンからも外へ出られる（建物内の代表点で閉じ込められない）", () => {
    // 回帰: サブステージは建物 b-sub の中にあり、
    // 「端点が建物内なら通行不可」としていた頃は全エッジが消えて到達不可だった
    const r = findRoute(zones, "sub", "aid", 16, S, "safe");
    expect(r).not.toBeNull();
    expect(r!.steps.length).toBeGreaterThan(1);
  });

  it("どのゾーン間でも到達できる（グラフが分断されていない）", () => {
    for (const from of zones) {
      for (const to of zones) {
        if (from.id === to.id) continue;
        expect(findRoute(zones, from.id, to.id, 16, S, "safe"), `${from.id}→${to.id}`).not.toBeNull();
      }
    }
  });

  it("混雑ペナルティが非線形: 迂回できるなら危険帯(≥75)の突っ切りを避ける", () => {
    // 回帰: 線形ペナルティだと混雑100のメインステージを突っ切る経路が選ばれていた
    const short = findRoute(zones, "wg", "aid", 16, S, "short")!;
    const safe = findRoute(zones, "wg", "aid", 16, S, "safe")!;
    expect(short.maxDensity).toBe(100); // 最短は混雑ピークを突っ切る
    expect(safe.maxDensity).toBeLessThan(short.maxDensity); // safeは迂回する
    expect(safe.meters).toBeGreaterThan(short.meters); // 迂回した分だけ長い
  });

  it("危険帯を通らざるを得ないときは警告を返す", () => {
    const r = findRoute(zones, "wg", "aid", 16, S, "safe")!;
    expect(r.maxDensity).toBeGreaterThanOrEqual(75);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join()).toContain("混雑");
  });

  it("代表点は label があればそれを使う（地図のラベル位置と一致させる）", () => {
    const main = zones.find((z) => z.id === "main")!;
    expect(anchorOf(main)).toEqual(main.label);
  });
});
