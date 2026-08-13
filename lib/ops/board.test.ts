import { describe, expect, it } from "vitest";
import {
  buildBoardMarks,
  isAssignedTo,
  latestDispatchFor,
  memberBadge,
  postCodeLabel,
} from "./board";
import { zoneById, type Post } from "./staffing";
import type { Dispatch, Staff } from "./store";
import { centroid } from "@/lib/forecast/model";

/**
 * lib/ops/board.ts の純関数層テスト（2026-08-13 新設）。
 *
 * adjust-console.tsx:240-289 のマーカー生成ロジックを純関数へ移植したもの。
 * 既存の startsWith バグ（"A-1" が "A-10" に誤マッチする）の修正確認、
 * presence専用スタッフ(zoneId="")の除外、ゴースト線の生成条件を固定する。
 */

// ── fixtures ─────────────────────────────────────────────────────

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

function fakeDispatch(overrides: Partial<Dispatch> & Pick<Dispatch, "id" | "staffName">): Dispatch {
  return {
    fromCode: "D-1",
    toZoneId: "main",
    toZoneName: "メインステージ",
    action: "移動",
    urgency: "soon",
    reason: "テスト",
    status: "sent",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fakePost(overrides: Partial<Post> & Pick<Post, "code" | "zoneId">): Post {
  return {
    zoneName: "",
    at: { x: 0, y: 0 },
    role: "water",
    ...overrides,
  };
}

// ── isAssignedTo ─────────────────────────────────────────────────

describe("isAssignedTo", () => {
  it("完全一致は true", () => {
    expect(isAssignedTo("A-1", "A-1")).toBe(true);
  });

  it("旧startsWithバグの修正: 'A-1' は 'A-10' にマッチしない", () => {
    expect(isAssignedTo("A-1", "A-10")).toBe(false);
  });

  it("旧startsWithバグの修正: 'A-1' は 'A-1→'（移動中コード）にマッチしない", () => {
    expect(isAssignedTo("A-1", "A-1→")).toBe(false);
    expect(isAssignedTo("A-1→", "A-1")).toBe(false);
  });

  it("空文字同士は false（空文字は未配置でありポストではない）", () => {
    expect(isAssignedTo("", "")).toBe(false);
  });
});

// ── postCodeLabel ────────────────────────────────────────────────

describe("postCodeLabel", () => {
  it("空文字 → 未配置", () => {
    expect(postCodeLabel("")).toBe("未配置");
  });

  it("末尾が「→」→ 元コードから移動中", () => {
    expect(postCodeLabel("A-1→")).toBe("A-1から移動中");
  });

  it("それ以外はそのまま", () => {
    expect(postCodeLabel("A-1")).toBe("A-1");
  });
});

// ── memberBadge ──────────────────────────────────────────────────

describe("memberBadge", () => {
  const now = 1_000_000_000;

  it("staff無し → unregistered（stale=false・unanswered=false）", () => {
    const badge = memberBadge(undefined, undefined, now);
    expect(badge).toEqual({ status: "unregistered", stale: false, unanswered: false });
  });

  it("postCode===''&&state==='away' → waiting", () => {
    const staff = fakeStaff({ name: "A", postCode: "", state: "away", updatedAt: now });
    expect(memberBadge(staff, undefined, now).status).toBe("waiting");
  });

  it("state==='onpost' → onpost（postCodeの中身は問わない）", () => {
    const staff = fakeStaff({ name: "A", postCode: "A-1", state: "onpost", updatedAt: now });
    expect(memberBadge(staff, undefined, now).status).toBe("onpost");
  });

  it("state==='moving' → moving", () => {
    const staff = fakeStaff({ name: "A", postCode: "A-1", state: "moving", updatedAt: now });
    expect(memberBadge(staff, undefined, now).status).toBe("moving");
  });

  it("postCode有り&&state==='away' → away", () => {
    const staff = fakeStaff({ name: "A", postCode: "A-1", state: "away", updatedAt: now });
    expect(memberBadge(staff, undefined, now).status).toBe("away");
  });

  it("stale境界: 15分ちょうどは false", () => {
    const staff = fakeStaff({ name: "A", updatedAt: now - 15 * 60_000 });
    expect(memberBadge(staff, undefined, now).stale).toBe(false);
  });

  it("stale境界: 15分+1msは true", () => {
    const staff = fakeStaff({ name: "A", updatedAt: now - (15 * 60_000 + 1) });
    expect(memberBadge(staff, undefined, now).stale).toBe(true);
  });

  it("unanswered境界: 10分ちょうどは false", () => {
    const staff = fakeStaff({ name: "A", updatedAt: now });
    const d = fakeDispatch({ id: "d1", staffName: "A", status: "sent", createdAt: now - 10 * 60_000 });
    expect(memberBadge(staff, d, now).unanswered).toBe(false);
  });

  it("unanswered境界: 10分+1msは true", () => {
    const staff = fakeStaff({ name: "A", updatedAt: now });
    const d = fakeDispatch({ id: "d1", staffName: "A", status: "sent", createdAt: now - (10 * 60_000 + 1) });
    expect(memberBadge(staff, d, now).unanswered).toBe(true);
  });

  it("unregistered + sent 10分超 → unanswered=true（事前配置の未応答検出）", () => {
    const d = fakeDispatch({ id: "d1", staffName: "Ghost", status: "sent", createdAt: now - (10 * 60_000 + 1) });
    const badge = memberBadge(undefined, d, now);
    expect(badge.status).toBe("unregistered");
    expect(badge.unanswered).toBe(true);
  });
});

// ── latestDispatchFor ────────────────────────────────────────────

describe("latestDispatchFor", () => {
  it("createdAt降順の先頭を返す", () => {
    const list: Dispatch[] = [
      fakeDispatch({ id: "d1", staffName: "A", createdAt: 100 }),
      fakeDispatch({ id: "d2", staffName: "A", createdAt: 300 }),
      fakeDispatch({ id: "d3", staffName: "A", createdAt: 200 }),
    ];
    expect(latestDispatchFor("A", list)?.id).toBe("d2");
  });

  it("cancelledはスキップする", () => {
    const list: Dispatch[] = [
      fakeDispatch({ id: "d1", staffName: "A", createdAt: 300, status: "cancelled" }),
      fakeDispatch({ id: "d2", staffName: "A", createdAt: 200, status: "sent" }),
    ];
    expect(latestDispatchFor("A", list)?.id).toBe("d2");
  });

  it("該当なしはundefined", () => {
    const list: Dispatch[] = [fakeDispatch({ id: "d1", staffName: "A", createdAt: 100 })];
    expect(latestDispatchFor("B", list)).toBeUndefined();
  });
});

// ── buildBoardMarks ──────────────────────────────────────────────

describe("buildBoardMarks", () => {
  const ann = fakeStaff({ name: "Ann", zoneId: "shop", postCode: "D-1", role: "water" });
  const bob = fakeStaff({ name: "Bob", zoneId: "shop", postCode: "D-2", role: "water" });
  // presence専用（zoneId=""）。マップ上に描いてはいけない
  const cara = fakeStaff({ name: "Cara", zoneId: "", postCode: "", role: "guide", state: "away" });

  const posts: Post[] = [
    fakePost({ code: "D-1", zoneId: "shop", role: "water" }),
    fakePost({ code: "D-2", zoneId: "shop", role: "water" }),
    fakePost({ code: "D-3", zoneId: "shop", role: "water" }),
    fakePost({ code: "G-1", zoneId: "wc", role: "water" }),
  ];

  it("zoneId=''のスタッフはmarks/zoneBadgesに出ない", () => {
    const model = buildBoardMarks([ann, bob, cara], posts, []);
    expect(model.entryStaff.some((s) => s?.name === "Cara")).toBe(false);
    expect(model.zoneBadges[""]).toBeUndefined();
    expect(model.zoneBadges).toEqual({ shop: 2 });
  });

  it("実在スタッフのglyphは頭文字、空席は役割グリフ", () => {
    const model = buildBoardMarks([ann, bob], posts, []);
    const annMark = model.marks[model.entryStaff.findIndex((s) => s?.name === "Ann")];
    expect(annMark.glyph).toBe("A");
    const vacant = model.marks.filter((_, i) => model.dimmedIdx.has(i));
    expect(vacant.every((m) => m.glyph === "水")).toBe(true);
  });

  it("空席dimmed数 = ポスト数 - 入場数", () => {
    const model = buildBoardMarks([ann, bob], posts, []);
    // shop: posts 3 - occupied 2 = 1 / wc: posts 1 - occupied 0 = 1 → 計2
    expect(model.dimmedIdx.size).toBe(2);
    expect(model.marks.length).toBe(2 /* 実在 */ + 2 /* 空席 */);
  });

  it("ghostsはsent/movingのみ・cancelled/arrivedは出ない・fromが見つからない場合null", () => {
    const dispatches: Dispatch[] = [
      fakeDispatch({ id: "d1", staffName: "Ann", toZoneId: "main", status: "sent" }),
      fakeDispatch({ id: "d2", staffName: "Bob", toZoneId: "main", status: "moving" }),
      fakeDispatch({ id: "d3", staffName: "Cara", toZoneId: "main", status: "sent" }), // zoneId=""で未描画→from null
      fakeDispatch({ id: "d4", staffName: "Ann", toZoneId: "main", status: "cancelled" }),
      fakeDispatch({ id: "d5", staffName: "Bob", toZoneId: "main", status: "arrived" }),
      fakeDispatch({ id: "d6", staffName: "Dan", toZoneId: "no-such-zone", status: "sent" }), // 不明ゾーン→スキップ
    ];
    const model = buildBoardMarks([ann, bob, cara], posts, dispatches);
    expect(model.ghosts).toHaveLength(3);

    const mainCentroid = centroid(zoneById("main")!.shape);
    const byGlyph = Object.fromEntries(model.ghosts.map((g) => [g.glyph, g]));

    expect(byGlyph["A"]).toMatchObject({ kind: "sent", to: mainCentroid });
    expect(byGlyph["A"].from).not.toBeNull();
    expect(byGlyph["B"]).toMatchObject({ kind: "moving", to: mainCentroid });
    expect(byGlyph["B"].from).not.toBeNull();
    expect(byGlyph["C"]).toMatchObject({ kind: "sent", to: mainCentroid, from: null });
  });
});
