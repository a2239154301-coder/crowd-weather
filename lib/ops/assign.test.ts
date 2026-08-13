import { describe, expect, it } from "vitest";
import {
  buildAssignmentContext,
  planInitialAssignment,
  validateAssignments,
  type AssignmentContext,
} from "./assign";
import { zoneById, type Post } from "./staffing";
import type { Dispatch, Staff } from "./store";
import type { RosterMember } from "@/lib/data/roster";
import { centroid } from "@/lib/forecast/model";

/**
 * lib/ops/assign.ts の純関数層テスト（2026-08-13 新設）。
 *
 * 開場前の一括初期配置（案の生成・検証）を固定する。
 * board.test.ts と同じ fixture パターン（Partial + Pick でオーバーライド）を使う。
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

function fakePost(overrides: Partial<Post> & Pick<Post, "code" | "zoneId" | "role">): Post {
  return {
    zoneName: "",
    at: { x: 0, y: 0 },
    ...overrides,
  };
}

function fakeMember(overrides: Partial<RosterMember> & Pick<RosterMember, "id" | "name">): RosterMember {
  return {
    role: "guide",
    group: "メイン",
    ...overrides,
  };
}

// ── buildAssignmentContext ──────────────────────────────────────

describe("buildAssignmentContext", () => {
  const now = 1_000_000_000;
  const roster: RosterMember[] = [
    fakeMember({ id: "s01", name: "佐藤", role: "guide", group: "メイン" }),
    fakeMember({ id: "s02", name: "高橋", role: "guide", group: "メイン" }),
    fakeMember({ id: "s03", name: "田中", role: "guide", group: "メイン" }),
    fakeMember({ id: "s12", name: "松本", role: "water", group: "給水" }),
  ];

  it("onpostのメンバーはcandidatesに入らない", () => {
    const staff = [fakeStaff({ name: "佐藤", state: "onpost", postCode: "C-1", zoneId: "main" })];
    const ctx = buildAssignmentContext(roster, [], staff, [], now);
    expect(ctx.candidates.some((c) => c.name === "佐藤")).toBe(false);
  });

  it("movingのメンバーはcandidatesに入らない", () => {
    const staff = [fakeStaff({ name: "高橋", state: "moving", postCode: "C-2", zoneId: "main" })];
    const ctx = buildAssignmentContext(roster, [], staff, [], now);
    expect(ctx.candidates.some((c) => c.name === "高橋")).toBe(false);
  });

  it("アクティブ指示(sent/moving)のあるメンバーはcandidatesに入らない（staffが未登録でも）", () => {
    const dispatches = [
      fakeDispatch({ id: "d1", staffName: "田中", status: "sent" }),
      fakeDispatch({ id: "d2", staffName: "松本", status: "moving" }),
    ];
    const ctx = buildAssignmentContext(roster, [], [], dispatches, now);
    expect(ctx.candidates.some((c) => c.name === "田中")).toBe(false);
    expect(ctx.candidates.some((c) => c.name === "松本")).toBe(false);
  });

  it("cancelled指示は無視され候補に残る", () => {
    const dispatches = [fakeDispatch({ id: "d1", staffName: "田中", status: "cancelled" })];
    const ctx = buildAssignmentContext(roster, [], [], dispatches, now);
    expect(ctx.candidates.some((c) => c.name === "田中")).toBe(true);
  });

  it("未登録・waiting・awayは候補に残り、fromCode/fromZoneIdを引き継ぐ", () => {
    const staff = [fakeStaff({ name: "松本", state: "away", postCode: "D-1", zoneId: "shop" })];
    const ctx = buildAssignmentContext(roster, [], staff, [], now);
    const c = ctx.candidates.find((x) => x.name === "松本");
    expect(c).toMatchObject({ fromCode: "D-1", fromZoneId: "shop" });
  });

  it("完全未登録メンバーはfromCode/fromZoneIdが空文字", () => {
    const ctx = buildAssignmentContext(roster, [], [], [], now);
    const c = ctx.candidates.find((x) => x.name === "佐藤");
    expect(c).toMatchObject({ fromCode: "", fromZoneId: "" });
  });

  it("candidatesはROSTER順", () => {
    const ctx = buildAssignmentContext(roster, [], [], [], now);
    expect(ctx.candidates.map((c) => c.name)).toEqual(["佐藤", "高橋", "田中", "松本"]);
  });

  it("着任済みポストはvacantPostsに入らない", () => {
    const posts = [fakePost({ code: "C-1", zoneId: "main", role: "guide" }), fakePost({ code: "C-2", zoneId: "main", role: "guide" })];
    const staff = [fakeStaff({ name: "誰か", postCode: "C-1", zoneId: "main", state: "onpost" })];
    const ctx = buildAssignmentContext([], posts, staff, [], now);
    expect(ctx.vacantPosts.map((p) => p.code)).toEqual(["C-2"]);
  });

  it("アクティブ指示のtoPostCodeに一致するポストはvacantPostsに入らない（moving先の予約）", () => {
    const posts = [fakePost({ code: "C-1", zoneId: "main", role: "guide" }), fakePost({ code: "C-2", zoneId: "main", role: "guide" })];
    const dispatches = [
      fakeDispatch({ id: "d1", staffName: "誰か", status: "sent", toPostCode: "C-2", toZoneId: "main" }),
    ];
    const ctx = buildAssignmentContext([], posts, [], dispatches, now);
    expect(ctx.vacantPosts.map((p) => p.code)).toEqual(["C-1"]);
  });

  it("cancelled/arrived指示のtoPostCodeは予約扱いにならない", () => {
    const posts = [fakePost({ code: "C-1", zoneId: "main", role: "guide" })];
    const dispatches = [
      fakeDispatch({ id: "d1", staffName: "誰か", status: "cancelled", toPostCode: "C-1", toZoneId: "main" }),
    ];
    const ctx = buildAssignmentContext([], posts, [], dispatches, now);
    expect(ctx.vacantPosts.map((p) => p.code)).toEqual(["C-1"]);
  });

  it("vacantPostsは自然順（'A-2'が'A-10'より前）", () => {
    const posts = [
      fakePost({ code: "A-10", zoneId: "wg", role: "guide" }),
      fakePost({ code: "A-2", zoneId: "wg", role: "guide" }),
      fakePost({ code: "A-1", zoneId: "wg", role: "guide" }),
      fakePost({ code: "B-1", zoneId: "eg", role: "guide" }),
    ];
    const ctx = buildAssignmentContext([], posts, [], [], now);
    expect(ctx.vacantPosts.map((p) => p.code)).toEqual(["A-1", "A-2", "A-10", "B-1"]);
  });
});

// ── planInitialAssignment ────────────────────────────────────────

describe("planInitialAssignment", () => {
  function ctxOf(
    candidates: AssignmentContext["candidates"],
    vacantPosts: Post[]
  ): AssignmentContext {
    return { candidates, vacantPosts };
  }

  it("全員未配置なら空席の数だけ割り当てが出る（候補=空席数）", () => {
    const candidates = [
      { memberId: "s01", name: "佐藤", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
      { memberId: "s02", name: "高橋", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [
      fakePost({ code: "C-1", zoneId: "main", role: "guide" }),
      fakePost({ code: "C-2", zoneId: "main", role: "guide" }),
    ];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
    expect(result.leftoverPosts).toHaveLength(0);
  });

  it("担当ゾーンが優先される（パス1。現在位置的にはaidの方が近くても担当ゾーンshopが選ばれる）", () => {
    // 給水の担当ゾーンは["shop","wc"]。aidは担当ゾーン外（=パス2でしか拾われない）。
    // 現在位置(fromZoneId="aid")のすぐ隣にaidの空席を置いても、パス1（役割一致+担当ゾーン）が
    // 先に候補を消費するため、パス2（現在位置優先）まで到達せずshopが選ばれるはず。
    const candidates = [
      { memberId: "s12", name: "松本", role: "water" as const, group: "給水" as const, fromCode: "", fromZoneId: "aid" },
    ];
    const aidCentroid = centroid(zoneById("aid")!.shape);
    const posts = [
      fakePost({ code: "H-1", zoneId: "aid", role: "water", at: aidCentroid }), // 担当ゾーン外・現在地の目の前
      fakePost({ code: "D-1", zoneId: "shop", role: "water", at: { x: aidCentroid.x + 9999, y: aidCentroid.y + 9999 } }), // 担当ゾーン・遠い
    ];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].toPostCode).toBe("D-1");
    expect(result.assignments[0].reason).toContain("担当ゾーンの空席");
    expect(result.assignments[0].source).toBe("calc");
  });

  it("現在位置がある人は最も近い空席が選ばれる（パス2）", () => {
    // フード班は postsFor() 上は担当ゾーンにポストが無い想定なので必ずパス2で拾われる。
    // shop寄りの位置から、shopの空席とmainの空席のうち近い方が選ばれることを確認する
    const candidates = [
      { memberId: "s06", name: "山本", role: "guide" as const, group: "フード" as const, fromCode: "F-1", fromZoneId: "food" },
    ];
    const shopCentroid = centroid(zoneById("shop")!.shape);
    const mainCentroid = centroid(zoneById("main")!.shape);
    const foodCentroid = centroid(zoneById("food")!.shape);
    // shop側の空席をfoodのすぐ近くに、main側の空席を遠くに置き、近接判定を明示的に検証する
    const near = { x: foodCentroid.x + 1, y: foodCentroid.y + 1 };
    const far = { x: mainCentroid.x + 10000, y: mainCentroid.y + 10000 };
    const posts = [
      fakePost({ code: "F-2", zoneId: "shop", role: "guide", at: near }),
      fakePost({ code: "C-1", zoneId: "main", role: "guide", at: far }),
    ];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].toPostCode).toBe("F-2");
    expect(result.assignments[0].reason).toContain("現在地から最も近い空席");
  });

  it("fromZoneIdが空の候補は空席の自然順で先頭が選ばれる", () => {
    const candidates = [
      { memberId: "s09", name: "加藤", role: "guide" as const, group: "サブ" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [
      fakePost({ code: "E-1", zoneId: "exit", role: "guide" }),
      fakePost({ code: "E-2", zoneId: "exit", role: "guide" }),
    ];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments[0].toPostCode).toBe("E-1");
    expect(result.assignments[0].reason).toContain("役割が一致する空席");
  });

  it("役割不一致の割り当ては作られない", () => {
    const candidates = [
      { memberId: "s14", name: "井上", role: "aid" as const, group: "救護" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [fakePost({ code: "D-1", zoneId: "shop", role: "water" })];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments).toHaveLength(0);
    expect(result.unassigned).toHaveLength(1);
    expect(result.leftoverPosts).toHaveLength(1);
  });

  it("空席<候補数のとき残りがunassignedに入る", () => {
    const candidates = [
      { memberId: "s01", name: "佐藤", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
      { memberId: "s02", name: "高橋", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [fakePost({ code: "C-1", zoneId: "main", role: "guide" })];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.unassigned).toHaveLength(1);
    expect(result.unassigned[0].name).toBe("高橋");
    expect(result.leftoverPosts).toHaveLength(0);
  });

  it("候補<空席数のとき残りがleftoverPostsに入る", () => {
    const candidates = [
      { memberId: "s01", name: "佐藤", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [
      fakePost({ code: "C-1", zoneId: "main", role: "guide" }),
      fakePost({ code: "C-2", zoneId: "main", role: "guide" }),
    ];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.unassigned).toHaveLength(0);
    expect(result.leftoverPosts).toHaveLength(1);
    expect(result.leftoverPosts[0].code).toBe("C-2");
  });

  it("同じ入力で2回呼んで結果が完全一致（決定性）", () => {
    const candidates = [
      { memberId: "s01", name: "佐藤", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
      { memberId: "s06", name: "山本", role: "guide" as const, group: "フード" as const, fromCode: "F-1", fromZoneId: "food" },
      { memberId: "s12", name: "松本", role: "water" as const, group: "給水" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [
      fakePost({ code: "C-1", zoneId: "main", role: "guide" }),
      fakePost({ code: "F-2", zoneId: "shop", role: "guide" }),
      fakePost({ code: "D-1", zoneId: "shop", role: "water" }),
    ];
    const ctx = ctxOf(candidates, posts);
    const r1 = planInitialAssignment(ctx);
    const r2 = planInitialAssignment(ctx);
    expect(r1).toEqual(r2);
  });

  it("1ポストに2人を割り当てない（同一postCodeの重複が出ない）", () => {
    const candidates = [
      { memberId: "s01", name: "佐藤", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
      { memberId: "s02", name: "高橋", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
      { memberId: "s03", name: "田中", role: "guide" as const, group: "メイン" as const, fromCode: "", fromZoneId: "" },
    ];
    const posts = [
      fakePost({ code: "C-1", zoneId: "main", role: "guide" }),
      fakePost({ code: "C-2", zoneId: "main", role: "guide" }),
    ];
    const ctx = ctxOf(candidates, posts);
    const result = planInitialAssignment(ctx);
    const codes = result.assignments.map((a) => a.toPostCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeLessThanOrEqual(posts.length);
  });
});

// ── validateAssignments ──────────────────────────────────────────

describe("validateAssignments", () => {
  function baseCtx(): AssignmentContext {
    return {
      candidates: [
        { memberId: "s01", name: "佐藤", role: "guide", group: "メイン", fromCode: "", fromZoneId: "" },
        { memberId: "s12", name: "松本", role: "water", group: "給水", fromCode: "", fromZoneId: "" },
      ],
      vacantPosts: [
        fakePost({ code: "C-1", zoneId: "main", zoneName: "メインステージ", role: "guide" }),
        fakePost({ code: "D-1", zoneId: "shop", zoneName: "物販の列", role: "water" }),
      ],
    };
  }

  it("架空の名前を棄却する", () => {
    const raw = [{ staffName: "存在しない人", toPostCode: "C-1", reason: "テスト" }];
    const result = validateAssignments(raw, baseCtx());
    expect(result.assignments).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });

  it("架空のポストコードを棄却する（ポストコードの発番を阻止する最重要チェック）", () => {
    const raw = [{ staffName: "佐藤", toPostCode: "Z-99", reason: "テスト" }];
    const result = validateAssignments(raw, baseCtx());
    expect(result.assignments).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });

  it("重複したstaffNameは2件目以降を棄却する", () => {
    const raw = [
      { staffName: "佐藤", toPostCode: "C-1", reason: "1件目" },
      { staffName: "佐藤", toPostCode: "D-1", reason: "2件目（本来水ではなく誘導なので役割不一致でもある）" },
    ];
    const ctx: AssignmentContext = {
      candidates: baseCtx().candidates,
      vacantPosts: [
        fakePost({ code: "C-1", zoneId: "main", role: "guide" }),
        fakePost({ code: "D-1", zoneId: "shop", role: "guide" }),
      ],
    };
    const result = validateAssignments(raw, ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].toPostCode).toBe("C-1");
    expect(result.rejected).toBe(1);
  });

  it("重複したtoPostCodeは2件目以降を棄却する", () => {
    const raw = [
      { staffName: "佐藤", toPostCode: "C-1", reason: "1件目" },
      { staffName: "松本", toPostCode: "C-1", reason: "2件目" },
    ];
    const ctx: AssignmentContext = {
      candidates: baseCtx().candidates,
      vacantPosts: [fakePost({ code: "C-1", zoneId: "main", role: "guide" })],
    };
    const result = validateAssignments(raw, ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].name).toBe("佐藤");
    expect(result.rejected).toBe(1);
  });

  it("配列でない入力で落ちない", () => {
    expect(() => validateAssignments(null, baseCtx())).not.toThrow();
    expect(() => validateAssignments(undefined, baseCtx())).not.toThrow();
    expect(() => validateAssignments("not an array", baseCtx())).not.toThrow();
    expect(() => validateAssignments({ foo: "bar" }, baseCtx())).not.toThrow();
    const result = validateAssignments("not an array", baseCtx());
    expect(result.assignments).toEqual([]);
  });

  it("要素がオブジェクトでない場合は棄却する", () => {
    const raw = [null, 42, "foo", { staffName: "佐藤", toPostCode: "C-1" }];
    const result = validateAssignments(raw, baseCtx());
    expect(result.assignments).toHaveLength(1);
    expect(result.rejected).toBe(3);
  });

  it("役割不一致は棄却せずwarningsに出る", () => {
    // 佐藤は誘導(guide)。給水ポストD-1に送る＝役割不一致だが、現場では兼任があるため棄却しない
    const raw = [{ staffName: "佐藤", toPostCode: "D-1", reason: "応援" }];
    const ctx: AssignmentContext = {
      candidates: baseCtx().candidates,
      vacantPosts: [fakePost({ code: "D-1", zoneId: "shop", role: "water" })],
    };
    const result = validateAssignments(raw, ctx);
    expect(result.assignments).toHaveLength(1);
    expect(result.rejected).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("佐藤");
  });

  it("toZoneIdはLLMの申告ではなくctxから引かれる", () => {
    const raw = [
      // LLMが（存在しないか誤った）toZoneIdを自己申告してきても無視されるべき
      { staffName: "佐藤", toPostCode: "C-1", toZoneId: "no-such-zone", reason: "テスト" },
    ];
    const result = validateAssignments(raw, baseCtx());
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].toZoneId).toBe("main");
    expect(result.assignments[0].toZoneName).toBe("メインステージ");
  });

  it("fromCode/roleはctx.candidates由来で、LLMの自己申告を無視する", () => {
    const raw = [{ staffName: "佐藤", toPostCode: "C-1", role: "aid", fromCode: "捏造", reason: "テスト" }];
    const ctx: AssignmentContext = {
      candidates: [
        { memberId: "s01", name: "佐藤", role: "guide", group: "メイン", fromCode: "A-1", fromZoneId: "wg" },
      ],
      vacantPosts: [fakePost({ code: "C-1", zoneId: "main", zoneName: "メインステージ", role: "guide" })],
    };
    const result = validateAssignments(raw, ctx);
    expect(result.assignments[0].role).toBe("guide");
    expect(result.assignments[0].fromCode).toBe("A-1");
  });

  it("reasonは120字で切って使う。無ければ空文字", () => {
    const long = "あ".repeat(200);
    const raw = [
      { staffName: "佐藤", toPostCode: "C-1", reason: long },
    ];
    const result = validateAssignments(raw, baseCtx());
    expect(result.assignments[0].reason).toHaveLength(120);

    const raw2 = [{ staffName: "松本", toPostCode: "D-1" }];
    const result2 = validateAssignments(raw2, baseCtx());
    expect(result2.assignments[0].reason).toBe("");
  });

  it("source は常に 'ai'", () => {
    const raw = [{ staffName: "佐藤", toPostCode: "C-1", reason: "テスト" }];
    const result = validateAssignments(raw, baseCtx());
    expect(result.assignments[0].source).toBe("ai");
  });
});
