import { describe, expect, it } from "vitest";
import { postsFor, zoneById, type Post } from "./staffing";
import type { DayPlan } from "@/lib/forecast/types";

/**
 * 受付ポスト（R系）追加のリグレッションテスト（2026-08-13）。
 *
 * 目的は主にひとつ: reception 追加前からある配分ロジック（A〜J系の採番・座標）が
 * 1件もズレていないことを固定する。受付ポストはA〜J系とは独立した `R` 接頭辞で
 * 採番するため、reception の有無で既存ポスト列が変わってはならない
 * （変わると「A-2へ」という無線指示と実配置がズレて事故になる）。
 */

function fakePlan(overrides: Partial<Pick<DayPlan, "water" | "guide" | "aid">>): DayPlan {
  const zone = zoneById("main")!;
  return {
    peakDensity: 50,
    peakDensityHour: 15,
    peakDensityZone: zone,
    peakWbgt: 29,
    peakWbgtHour: 14,
    peakWbgtZone: zone,
    waitMin: 5,
    water: 1,
    aid: 1,
    guide: 2,
    mist: false,
    oneway: false,
    entryControl: false,
    stationCoord: false,
    corridorDanger: false,
    outsideDanger: false,
    baselinePersonHours: 0,
    optimizedPersonHours: 0,
    savedPercent: 0,
    tents: { total: 0, list: [] },
    ...overrides,
  };
}

/** A〜J系のみ抽出（reception=R系を除く） */
function nonReceptionPosts(posts: Post[]): Post[] {
  return posts.filter((p) => p.role !== "reception");
}

describe("postsFor — reception 追加後の既存ロジック固定", () => {
  const cases: Partial<Pick<DayPlan, "water" | "guide" | "aid">>[] = [
    { water: 1, guide: 2, aid: 1 }, // 既定値（増員なし）
    { water: 3, guide: 4, aid: 3 }, // water>2 / guide>3 / aid>2 の分岐
    { water: 5, guide: 8, aid: 5 }, // guide>5（ゲートへのオーバーフロー）の分岐
    { water: 0, guide: 0, aid: 0 }, // ゼロ人数
  ];

  for (const c of cases) {
    it(`plan=${JSON.stringify(c)}: reception あり/なしで既存ポスト列(A〜J系)が完全一致`, () => {
      const plan = fakePlan(c);
      const withReception = nonReceptionPosts(postsFor(plan, { reception: true }));
      const withoutReception = nonReceptionPosts(postsFor(plan, { reception: false }));
      const defaultCall = nonReceptionPosts(postsFor(plan));
      expect(withReception).toEqual(withoutReception);
      expect(defaultCall).toEqual(withReception);
    });
  }

  it("既存A〜J系コード採番のスナップショット固定（全分岐を通る water=5/guide=8/aid=5）", () => {
    const plan = fakePlan({ water: 5, guide: 8, aid: 5 });
    const codes = nonReceptionPosts(postsFor(plan)).map((p) => p.code);
    expect(codes).toEqual([
      "D-1", "D-2", // shop water min(2,5)
      "G-1", // wc water>2 の1名
      "C-1", "C-2", "C-3", // main guide min(3,8)
      "E-1", "E-2", // exit guide min(2, 8-3)
      "A-1", "A-2", // wg guide オーバーフロー ceil((8-5)/2)
      "B-1", // eg guide オーバーフロー floor((8-5)/2)
      "H-1", "H-2", // aid min(2,5)
      "H-3", "H-4", "H-5", // aid>2 の残り
    ]);
  });

  it("受付ポストは既定でR-1〜R-8の固定8件（西ゲートR-1〜4・東ゲートR-5〜8）", () => {
    const posts = postsFor(fakePlan({}));
    const reception = posts.filter((p) => p.role === "reception");
    expect(reception.map((p) => p.code)).toEqual([
      "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7", "R-8",
    ]);
    expect(reception.slice(0, 4).every((p) => p.zoneId === "wg")).toBe(true);
    expect(reception.slice(4).every((p) => p.zoneId === "eg")).toBe(true);
  });

  it("受付ポストの座標は同一ゾーン内で1行(y共通)・40px間隔で横並び", () => {
    // 2026-08-14: 人員配置エディタで駒（r=13→16）と間隔（34px→40px）を拡張したため、
    // この座標固定テストの期待値もあわせて更新する（staffing.ts put()/putReceptionRow() 参照）
    const posts = postsFor(fakePlan({}));
    const wgR = posts.filter((p) => p.zoneId === "wg" && p.role === "reception");
    expect(wgR).toHaveLength(4);
    const ys = new Set(wgR.map((p) => p.at.y));
    expect(ys.size).toBe(1);
    const xs = wgR.map((p) => p.at.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeCloseTo(40, 5);
    }
  });

  it("opts.reception=false で受付ポストは0件（既存ポストは変わらない）", () => {
    const plan = fakePlan({ water: 4, guide: 6, aid: 4 });
    const posts = postsFor(plan, { reception: false });
    expect(posts.filter((p) => p.role === "reception")).toHaveLength(0);
    expect(posts).toEqual(nonReceptionPosts(postsFor(plan, { reception: false })));
  });

  it("決定性: 同一入力なら同一出力（reception込み）", () => {
    const plan = fakePlan({ water: 4, guide: 7, aid: 4 });
    expect(postsFor(plan)).toEqual(postsFor(plan));
  });
});
