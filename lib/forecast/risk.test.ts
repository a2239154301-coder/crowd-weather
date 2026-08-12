import { describe, expect, it } from "vitest";
import {
  ALL_ZONES,
  TIME_BANDS,
  arrivalOrder,
  riskCause,
  riskLabel,
  riskSeverity,
  timeBand,
  zoneRisks,
} from "./risk";
import { DENSITY_BANDS, densityBand, wbgtBand } from "./scales";
import { DEFAULT_SCENARIO, HOURS, zonesFor } from "./venue";
import { forecastZones } from "./model";

/**
 * 総合リスク層の仕様固定。
 *
 * ここで守りたいのは配色でも見た目でもなく、**指標が一日を通して動くこと**。
 * 暑熱を主指標にすると既定条件では11:00〜17:00が全面最上位帯に貼りつくので、
 * 「混雑が主・暑熱が一段押し上げる」判定に固定する。
 */

const S = DEFAULT_SCENARIO;

describe("riskSeverity — 混雑が主・暑熱が一段押し上げる", () => {
  it("暑熱が危険帯(31℃以上)なら混雑の段を1つ上げる", () => {
    // 混雑24=快適(0) → 注意(1)
    expect(riskSeverity(24, 33)).toBe(1);
    // 混雑60=混雑(2) → 危険(3)
    expect(riskSeverity(60, 33)).toBe(3);
  });

  it("暑熱が危険帯未満なら混雑の段のまま", () => {
    expect(riskSeverity(24, 30.9)).toBe(0);
    expect(riskSeverity(60, 30.9)).toBe(2);
    expect(riskSeverity(80, 30.9)).toBe(3);
  });

  it("暑熱だけでは危険にならない", () => {
    // 誰もいない場所がどれだけ暑くても雑踏事故は起きない（企画書POINT01の事故はすべて密度側）
    expect(riskSeverity(0, 40)).toBeLessThan(3);
    expect(riskSeverity(24, 40)).toBeLessThan(3);
  });

  it("3を超えない", () => {
    expect(riskSeverity(100, 40)).toBe(3);
  });

  it("dSev × wSev の全16通りで min(3, d + (w===3?1:0)) と一致する", () => {
    const dv = [10, 30, 60, 90];
    const wv = [20, 26, 29, 33];
    for (const d of dv) {
      for (const w of wv) {
        const expected = Math.min(
          3,
          densityBand(d).severity + (wbgtBand(w).severity === 3 ? 1 : 0)
        );
        expect(riskSeverity(d, w)).toBe(expected);
      }
    }
  });
});

describe("riskCause — 打ち手が変わるので要因を持ち回る", () => {
  it("暑熱が押し上げに効いているときだけ「＋暑熱」を出す", () => {
    expect(riskCause(60, 33)).toBe("混雑＋暑熱");
    expect(riskCause(60, 29)).toBe("混雑");
  });

  it("すでに混雑だけで危険なら「混雑」とする", () => {
    expect(riskCause(90, 33)).toBe("混雑");
  });

  it("人がいなければ要因なし", () => {
    expect(riskCause(10, 29)).toBeNull();
  });
});

describe("TIME_BANDS — ΔE検証済み資産の引き継ぎ", () => {
  it("DENSITY_BANDS の4色を同じ重篤度順で流用している", () => {
    // 色を差し替えると 2026-08-09 のΔE検証（隣接16.6 / 色覚型8.9）の根拠を失う
    expect(TIME_BANDS.map((b) => b.color)).toEqual(DENSITY_BANDS.map((b) => b.color));
    expect(TIME_BANDS.map((b) => b.severity)).toEqual([0, 1, 2, 3]);
  });

  it("残り時間を4段に畳む", () => {
    expect(timeBand(0).severity).toBe(3);
    expect(timeBand(1).severity).toBe(2);
    expect(timeBand(2).severity).toBe(1);
    expect(timeBand(3).severity).toBe(1);
    expect(timeBand(4).severity).toBe(0);
    expect(timeBand(null).severity).toBe(0);
  });
});

describe("zoneRisks — 既定シナリオで一日が動く", () => {
  it("11:00に全ゾーンが危険にはならない（暑熱飽和で塗り潰されていない証明）", () => {
    // 34℃・晴れの11:00は日なたのWBGTがすでに31℃超。暑熱主の指標ならここで全面危険になる
    const r = zoneRisks(ALL_ZONES, 11, S);
    const danger = r.filter((z) => z.severity === 3);
    expect(danger.length).toBeLessThan(r.length / 2);
  });

  it("危険なゾーンの数が一日のなかで変化する（＝地図が動く）", () => {
    const counts = HOURS.map(
      (h) => zoneRisks(ALL_ZONES, h, S).filter((z) => z.severity === 3).length
    );
    expect(new Set(counts).size).toBeGreaterThan(1);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });

  it("開場時はゲート、終演時は退場動線と駅が危険側に出る", () => {
    const open = zoneRisks(ALL_ZONES, 11, S);
    const egress = zoneRisks(ALL_ZONES, 20, S);
    const sev = (rs: ReturnType<typeof zoneRisks>, id: string) =>
      rs.find((r) => r.zone.id === id)!.severity;

    // 開場の1.7倍係数が効くゲートは、同時刻の屋内サブステージより高い
    expect(sev(open, "wg")).toBeGreaterThan(sev(open, "sub"));
    // 終演の退場動線・駅コンコース・商店街の路地はいずれも危険
    expect(sev(egress, "exit")).toBe(3);
    expect(sev(egress, "conc")).toBe(3);
    expect(sev(egress, "alley")).toBe(3);
  });

  it("severity 3 のゾーンは hoursToDanger が 0 になる", () => {
    for (const h of HOURS) {
      for (const r of zoneRisks(ALL_ZONES, h, S)) {
        if (r.severity === 3) expect(r.hoursToDanger).toBe(0);
      }
    }
  });

  it("hoursToDanger は forecastZones を前方走査した最初の危険時刻と一致する", () => {
    const hour = 13;
    const risks = zoneRisks(ALL_ZONES, hour, S);
    for (const r of risks) {
      let expected: number | null = null;
      for (const h of HOURS.filter((x) => x >= hour)) {
        const f = forecastZones(ALL_ZONES, h, S).find((x) => x.zone.id === r.zone.id)!;
        if (riskSeverity(f.density, f.wbgt) === 3) {
          expected = h;
          break;
        }
      }
      expect(r.dangerHour).toBe(expected);
    }
  });

  it("dangerDensity / dangerWbgt は「いまの値」ではなく危険になる時刻の予報値", () => {
    // 「17:00に物販の列が混雑88まで上がる」と言えることが製品の主張。
    // ここにいまの値を入れると、当日モードの主表示が現在値の言い換えになって差別化が消える
    const risks = zoneRisks(ALL_ZONES, 11, S);
    const later = risks.filter((r) => (r.hoursToDanger ?? 0) > 0);
    expect(later.length).toBeGreaterThan(0);
    for (const r of later) {
      const at = forecastZones(ALL_ZONES, r.dangerHour!, S).find(
        (f) => f.zone.id === r.zone.id
      )!;
      expect(r.dangerDensity).toBe(at.density);
      expect(r.dangerWbgt).toBe(at.wbgt);
      expect(riskSeverity(r.dangerDensity!, r.dangerWbgt!)).toBe(3);
    }
    // 少なくとも1つは、いまの混雑より危険時のほうが高い（＝現在値の写しではない）
    expect(later.some((r) => r.dangerDensity! > r.density)).toBe(true);
  });

  it("いま危険なゾーンは danger 値が現在値と一致する", () => {
    for (const r of zoneRisks(ALL_ZONES, 15, S)) {
      if (r.severity !== 3) continue;
      expect(r.dangerDensity).toBe(r.density);
      expect(r.dangerWbgt).toBe(r.wbgt);
    }
  });

  it("危険にならないゾーンの danger 値は null", () => {
    for (const r of zoneRisks(ALL_ZONES, 15, S)) {
      if (r.hoursToDanger !== null) continue;
      expect(r.dangerDensity).toBeNull();
      expect(r.dangerWbgt).toBeNull();
    }
  });

  it("時刻を1つ進めると残り時間は1以上減る（危険時刻は動かないので）", () => {
    const a = zoneRisks(ALL_ZONES, 13, S);
    const b = zoneRisks(ALL_ZONES, 14, S);
    for (const x of a) {
      if (x.dangerHour === null || x.dangerHour < 14) continue;
      const y = b.find((z) => z.zone.id === x.zone.id)!;
      expect(y.dangerHour).toBe(x.dangerHour);
      expect(y.hoursToDanger!).toBe(x.hoursToDanger! - 1);
    }
  });

  it("会場内だけを渡しても動く（scope 切替に耐える）", () => {
    const r = zoneRisks(zonesFor("in"), 15, S);
    expect(r).toHaveLength(zonesFor("in").length);
  });
});

describe("arrivalOrder — 危険の到来順", () => {
  it("いま危険なものが先、その後は早い順", () => {
    const list = arrivalOrder(zoneRisks(ALL_ZONES, 13, S));
    const hs = list.map((r) => r.hoursToDanger!);
    expect(hs).toEqual([...hs].sort((a, b) => a - b));
  });

  it("終演まで危険にならないゾーンは落とす", () => {
    const list = arrivalOrder(zoneRisks(ALL_ZONES, 13, S));
    expect(list.every((r) => r.hoursToDanger !== null)).toBe(true);
  });
});

describe("riskLabel", () => {
  it("いま危険 / 危険になる時刻 / 安全 の3通りを出す", () => {
    const risks = zoneRisks(ALL_ZONES, 13, S);
    const now = risks.find((r) => r.hoursToDanger === 0);
    const later = risks.find((r) => (r.hoursToDanger ?? 0) > 0);
    const safe = risks.find((r) => r.hoursToDanger === null);
    if (now) expect(riskLabel(now)).toBe("いま危険");
    if (later) expect(riskLabel(later)).toBe(`${later.dangerHour}:00 危険`);
    if (safe) expect(riskLabel(safe)).toBe("安全");
  });
});
