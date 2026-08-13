import { describe, expect, it } from "vitest";
import { buildProposalContext } from "./proposal-context";
import { zoneById } from "./staffing";
import type { CorrectedZone } from "@/lib/ui/use-nowcast";
import type { Report, Staff } from "./store";

/**
 * lib/ops/proposal-context.ts の純関数層テスト（2026-08-13 新設）。
 *
 * adjust-console.tsx:179-200 の context 組み立てを移植したもの。
 * `/api/propose` のプロンプトはここのキー名を前提にしているため、
 * キー名そのものを文字列でアサートしてリグレッションを検出する。
 */

function fakeCorrected(overrides: Partial<CorrectedZone> & { zoneId: string }): CorrectedZone {
  const zone = zoneById(overrides.zoneId)!;
  return {
    zone,
    predicted: 50,
    observed: null,
    conflict: false,
    correctedValue: 50,
    factor: 1,
    ...overrides,
  };
}

function fakeStaff(overrides: Partial<Staff> & Pick<Staff, "name">): Staff {
  return {
    role: "water",
    postCode: "D-1",
    zoneId: "shop",
    state: "onpost",
    updatedAt: 0,
    ...overrides,
  };
}

function fakeReport(overrides: Partial<Report> & Pick<Report, "id">): Report {
  return {
    name: "スタッフA",
    zoneId: "wg",
    kind: "crowd",
    level: 3,
    text: "",
    summary: "混雑中",
    source: "staff-button",
    at: 0,
    ...overrides,
  };
}

describe("buildProposalContext", () => {
  it("correctedValue >= 60 のゾーンだけが risky に入る", () => {
    const corrected = [
      fakeCorrected({ zoneId: "wg", correctedValue: 59 }),
      fakeCorrected({ zoneId: "main", correctedValue: 60 }),
      fakeCorrected({ zoneId: "shop", correctedValue: 90 }),
    ];
    const ctx = buildProposalContext(15, corrected, [], []);
    const risky = ctx.risky as Array<{ zoneId: string }>;
    expect(risky.map((r) => r.zoneId)).toEqual(["main", "shop"]);
  });

  it("直近の報告 が6件で切られる", () => {
    const reports = Array.from({ length: 9 }, (_, i) => fakeReport({ id: `r${i}`, summary: `報告${i}` }));
    const ctx = buildProposalContext(15, [], [], reports);
    expect(ctx["直近の報告"]).toHaveLength(6);
  });

  it("キー名が期待どおり（トップレベル）", () => {
    const ctx = buildProposalContext(15, [], [], []);
    expect(Object.keys(ctx).sort()).toEqual(
      ["hour", "timetable", "risky", "現在配置", "直近の報告"].sort()
    );
  });

  it("キー名が期待どおり（risky内）", () => {
    const corrected = [fakeCorrected({ zoneId: "main", correctedValue: 75 })];
    const ctx = buildProposalContext(15, corrected, [], []);
    const risky = ctx.risky as Array<Record<string, unknown>>;
    expect(Object.keys(risky[0]).sort()).toEqual(
      ["zoneId", "zone", "予測", "補正後", "観測あり", "食い違い"].sort()
    );
  });

  it("hour は 'H:00' 形式の文字列", () => {
    const ctx = buildProposalContext(9, [], [], []);
    expect(ctx.hour).toBe("9:00");
  });

  it("現在配置 はスタッフの name/post/zone/role/state を持つ", () => {
    const staff = [fakeStaff({ name: "田中", postCode: "A-1", zoneId: "wg", role: "guide", state: "moving" })];
    const ctx = buildProposalContext(15, [], staff, []);
    const list = ctx["現在配置"] as Array<Record<string, unknown>>;
    expect(list).toEqual([
      { name: "田中", post: "A-1", zone: zoneById("wg")!.name, role: "誘導", state: "moving" },
    ]);
  });
});
