import { describe, expect, it } from "vitest";
import {
  newDraftFromAssignments,
  movePlacement,
  unassignPlacement,
  validatePlan,
  vacantPostsOf,
  unassignedMembers,
  sanitizeDeploymentPlan,
  sanitizePlacements,
  type DeploymentPlan,
  type Placement,
} from "./deployment";
import { postsFor, type Post } from "./staffing";
import type { Assignment } from "./assign";
import { VENUE, DEFAULT_SCENARIO } from "@/lib/forecast/venue";
import { dayPlan } from "@/lib/forecast/model";
import { ROSTER } from "@/lib/data/roster";

/**
 * lib/ops/deployment.ts の純関数層テスト（2026-08-14 新設）。
 *
 * このテストが固定したいのは「孤児化根絶」という設計目的そのもの:
 * Staff.postCode というスカラー1個しか持たなかった旧設計では、チケット数を変えると
 * postsFor(dayPlan(scenario)) のポスト列が動き、着任済みスタッフが盤面から消えた
 * （staffing.ts:101-110 が認識している事故）。DeploymentPlan.posts にスナップショットを
 * 凍結することで、この根本原因を断つ。
 */

// ── fixtures ─────────────────────────────────────────────────────

function fakePost(overrides: Partial<Post> & Pick<Post, "code" | "zoneId">): Post {
  return { zoneName: "", at: { x: 0, y: 0 }, role: "guide", ...overrides };
}

function fakePlacement(overrides: Partial<Placement> & Pick<Placement, "memberId" | "postCode">): Placement {
  return {
    name: "テスト太郎",
    role: "guide",
    zoneId: "main",
    fromHour: VENUE.open,
    toHour: VENUE.close,
    ...overrides,
  };
}

function fakePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    id: "dp-test-1",
    status: "draft",
    placements: [],
    posts: [],
    scenarioSnapshot: { tickets: 24000, weather: "sunny", temp: 34 },
    version: 1,
    createdAt: 0,
    ...overrides,
  };
}

function fakeAssignment(overrides: Partial<Assignment> & Pick<Assignment, "memberId" | "toPostCode">): Assignment {
  return {
    name: "テスト太郎",
    role: "guide",
    fromCode: "",
    toZoneId: "main",
    toZoneName: "メインステージ",
    reason: "テスト",
    source: "calc",
    ...overrides,
  };
}

// ── newDraftFromAssignments ─────────────────────────────────────

describe("newDraftFromAssignments", () => {
  const assignments: Assignment[] = [
    fakeAssignment({ memberId: "s01", name: "佐藤", toPostCode: "C-1" }),
    fakeAssignment({ memberId: "s02", name: "高橋", toPostCode: "C-2" }),
  ];
  const posts: Post[] = [
    fakePost({ code: "C-1", zoneId: "main" }),
    fakePost({ code: "C-2", zoneId: "main" }),
    fakePost({ code: "C-3", zoneId: "main" }),
  ];
  const snapshot = { tickets: 24000, weather: "sunny", temp: 34 };

  it("決定的である（同じ入力なら常にdeep-equal）", () => {
    const a = newDraftFromAssignments(assignments, posts, snapshot, 1000);
    const b = newDraftFromAssignments(assignments, posts, snapshot, 1000);
    expect(a).toEqual(b);
  });

  it("posts スナップショットが引数の posts と完全一致する（凍結されている）", () => {
    const plan = newDraftFromAssignments(assignments, posts, snapshot, 1000);
    expect(plan.posts).toEqual(posts);
  });

  it("posts は複製であり、呼び出し元の配列を後から書き換えても影響を受けない", () => {
    const mutablePosts = [...posts];
    const plan = newDraftFromAssignments(assignments, mutablePosts, snapshot, 1000);
    mutablePosts.push(fakePost({ code: "Z-9", zoneId: "main" }));
    expect(plan.posts).toHaveLength(3);
  });

  it("fromHour/toHourはVENUE.open/closeで埋まる", () => {
    const plan = newDraftFromAssignments(assignments, posts, snapshot, 1000);
    for (const p of plan.placements) {
      expect(p.fromHour).toBe(VENUE.open);
      expect(p.toHour).toBe(VENUE.close);
    }
  });

  it("version:1・status:draft で作られる", () => {
    const plan = newDraftFromAssignments(assignments, posts, snapshot, 1000);
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("draft");
    expect(plan.id).toMatch(/^dp-1000-/);
  });

  it("Assignment[] を Placement[] に変換する（人数・対応が一致）", () => {
    const plan = newDraftFromAssignments(assignments, posts, snapshot, 1000);
    expect(plan.placements).toHaveLength(2);
    expect(plan.placements.map((p) => p.postCode).sort()).toEqual(["C-1", "C-2"]);
    expect(plan.placements.map((p) => p.memberId).sort()).toEqual(["s01", "s02"]);
  });
});

// ── movePlacement ────────────────────────────────────────────────

describe("movePlacement", () => {
  const posts: Post[] = [
    fakePost({ code: "C-1", zoneId: "main" }),
    fakePost({ code: "C-2", zoneId: "main" }),
    fakePost({ code: "C-3", zoneId: "main" }),
  ];

  it("空席への移動: postCode/zoneIdが更新される", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const result = movePlacement(plan, "s01", "C-2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const moved = result.plan.placements.find((p) => p.memberId === "s01");
      expect(moved?.postCode).toBe("C-2");
      expect(moved?.zoneId).toBe("main");
      expect(result.swappedWith).toBeUndefined();
    }
  });

  it("孤児化の根絶: plan.posts に無いコードへの移動は拒否される", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const result = movePlacement(plan, "s01", "Z-99");
    expect(result).toEqual({ ok: false, reason: "unknown-post" });
  });

  it("占有ポストへの移動はswapになり、どちらも消えない", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", name: "佐藤", postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: "s02", name: "高橋", postCode: "C-2", zoneId: "main" }),
      ],
    });
    const result = movePlacement(plan, "s01", "C-2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.swappedWith).toBe("s02");
      expect(result.plan.placements).toHaveLength(2);
      const s01 = result.plan.placements.find((p) => p.memberId === "s01");
      const s02 = result.plan.placements.find((p) => p.memberId === "s02");
      expect(s01?.postCode).toBe("C-2");
      expect(s02?.postCode).toBe("C-1");
    }
  });

  it("同一ポストへの移動はno-op（reason: same-post）", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const result = movePlacement(plan, "s01", "C-1");
    expect(result).toEqual({ ok: false, reason: "same-post" });
  });

  it("名簿に無い/配置されていないmemberIdはunknown-member", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const result = movePlacement(plan, "ghost", "C-2");
    expect(result).toEqual({ ok: false, reason: "unknown-member" });
  });

  it("元のplanを破壊的変更しない", () => {
    const original = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", name: "佐藤", postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: "s02", name: "高橋", postCode: "C-2", zoneId: "main" }),
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(original));
    const result = movePlacement(original, "s01", "C-2");
    expect(original).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan).not.toBe(original);
      expect(result.plan.placements).not.toBe(original.placements);
    }
  });
});

// ── unassignPlacement ────────────────────────────────────────────

describe("unassignPlacement", () => {
  const posts: Post[] = [fakePost({ code: "C-1", zoneId: "main" }), fakePost({ code: "C-2", zoneId: "main" })];

  it("該当メンバーのplacementを外す（駒箱へ戻す）", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: "s02", postCode: "C-2", zoneId: "main" }),
      ],
    });
    const result = unassignPlacement(plan, "s01");
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0].memberId).toBe("s02");
  });

  it("元のplanを破壊的変更しない", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const snapshot = JSON.parse(JSON.stringify(plan));
    unassignPlacement(plan, "s01");
    expect(plan).toEqual(snapshot);
  });

  it("存在しないmemberIdを外そうとしても placements は変わらない", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const result = unassignPlacement(plan, "ghost");
    expect(result.placements).toHaveLength(1);
  });
});

// ── validatePlan ─────────────────────────────────────────────────

describe("validatePlan — 不変条件1〜5", () => {
  const posts: Post[] = [
    fakePost({ code: "C-1", zoneId: "main" }),
    fakePost({ code: "C-2", zoneId: "main" }),
  ];

  it("有効なplanはok:true・errors:[]", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    expect(validatePlan(plan)).toEqual({ ok: true, errors: [] });
  });

  it("不変条件1: 同一memberIdが2件あると弾く", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: "s01", postCode: "C-2", zoneId: "main" }),
      ],
    });
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("s01"))).toBe(true);
  });

  it("不変条件2: 同一postCodeが2件あると弾く", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: "s02", postCode: "C-1", zoneId: "main" }),
      ],
    });
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("C-1"))).toBe(true);
  });

  it("不変条件3（孤児化根絶の本体）: plan.postsに無いpostCodeを弾く", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "Z-99", zoneId: "main" })],
    });
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Z-99"))).toBe(true);
  });

  it("不変条件4: post.zoneIdが実在しないと弾く", () => {
    const plan = fakePlan({
      posts: [fakePost({ code: "C-1", zoneId: "no-such-zone" })],
      placements: [],
    });
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("no-such-zone"))).toBe(true);
  });

  it("不変条件5: fromHour>=toHourを弾く", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main", fromHour: 15, toHour: 15 }),
      ],
    });
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("不変条件5: fromHourがVENUE.open未満を弾く", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main", fromHour: VENUE.open - 1, toHour: VENUE.close }),
      ],
    });
    expect(validatePlan(plan).ok).toBe(false);
  });

  it("不変条件5: toHourがVENUE.close超過を弾く", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main", fromHour: VENUE.open, toHour: VENUE.close + 1 }),
      ],
    });
    expect(validatePlan(plan).ok).toBe(false);
  });
});

// ── vacantPostsOf / unassignedMembers（保存則） ──────────────────

describe("vacantPostsOf / unassignedMembers — 保存則（黙って落ちない）", () => {
  const posts: Post[] = [
    fakePost({ code: "C-1", zoneId: "main" }),
    fakePost({ code: "C-2", zoneId: "main" }),
    fakePost({ code: "C-3", zoneId: "main" }),
    fakePost({ code: "C-10", zoneId: "main" }),
  ];

  it("空席数 + 割当数 = posts数", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: "s02", postCode: "C-2", zoneId: "main" }),
      ],
    });
    const vacant = vacantPostsOf(plan);
    expect(vacant.length + plan.placements.length).toBe(posts.length);
  });

  it("空席はコードの自然順（C-2の次はC-3、C-10は最後）", () => {
    const plan = fakePlan({
      posts,
      placements: [fakePlacement({ memberId: "s01", postCode: "C-1", zoneId: "main" })],
    });
    const vacant = vacantPostsOf(plan);
    expect(vacant.map((p) => p.code)).toEqual(["C-2", "C-3", "C-10"]);
  });

  it("未割当数 + 割当数 = 名簿数", () => {
    const plan = fakePlan({
      posts,
      placements: [
        fakePlacement({ memberId: ROSTER[0].id, postCode: "C-1", zoneId: "main" }),
        fakePlacement({ memberId: ROSTER[1].id, postCode: "C-2", zoneId: "main" }),
      ],
    });
    const unassigned = unassignedMembers(ROSTER, plan);
    expect(unassigned.length + plan.placements.length).toBe(ROSTER.length);
  });

  it("unassignedMembersはROSTER順を保つ", () => {
    const plan = fakePlan({ posts, placements: [] });
    const unassigned = unassignedMembers(ROSTER, plan);
    expect(unassigned.map((m) => m.id)).toEqual(ROSTER.map((m) => m.id));
  });
});

// ── sanitizeDeploymentPlan ───────────────────────────────────────

describe("sanitizeDeploymentPlan — 防御的検証", () => {
  const validPosts = [{ code: "C-1", zoneId: "main", zoneName: "メインステージ", at: { x: 0, y: 0 }, role: "guide" }];

  it("配列でないposts/placementsを弾く", () => {
    const result = sanitizeDeploymentPlan({ posts: "not-array", placements: "not-array" });
    expect(result.posts).toEqual([]);
    expect(result.placements).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("架空zoneIdのpostを弾く", () => {
    const result = sanitizeDeploymentPlan({
      posts: [{ code: "C-1", zoneId: "no-such-zone" }],
      placements: [],
    });
    expect(result.posts).toEqual([]);
    expect(result.rejected.posts).toBe(1);
  });

  it("書式外postCodeのpostを弾く", () => {
    const result = sanitizeDeploymentPlan({
      posts: [{ code: "xx", zoneId: "main" }],
      placements: [],
    });
    expect(result.posts).toEqual([]);
    expect(result.rejected.posts).toBe(1);
  });

  it("名簿外の氏名のplacementを弾く", () => {
    const result = sanitizeDeploymentPlan({
      posts: validPosts,
      placements: [{ name: "存在しない名前ZZZ", postCode: "C-1" }],
    });
    expect(result.placements).toEqual([]);
    expect(result.rejected.placements).toBe(1);
  });

  it("書式外postCodeのplacementを弾く", () => {
    const result = sanitizeDeploymentPlan({
      posts: validPosts,
      placements: [{ name: "佐藤", postCode: "xx" }],
    });
    expect(result.placements).toEqual([]);
    expect(result.rejected.placements).toBe(1);
  });

  it("同一memberId(氏名)の重複placementは2件目以降を棄却", () => {
    const posts = [
      { code: "C-1", zoneId: "main" },
      { code: "C-2", zoneId: "main" },
    ];
    const result = sanitizeDeploymentPlan({
      posts,
      placements: [
        { name: "佐藤", postCode: "C-1" },
        { name: "佐藤", postCode: "C-2" },
      ],
    });
    expect(result.placements).toHaveLength(1);
    expect(result.rejected.placements).toBe(1);
  });

  it("同一postCodeの重複placementは2件目以降を棄却", () => {
    const result = sanitizeDeploymentPlan({
      posts: validPosts,
      placements: [
        { name: "佐藤", postCode: "C-1" },
        { name: "高橋", postCode: "C-1" },
      ],
    });
    expect(result.placements).toHaveLength(1);
    expect(result.rejected.placements).toBe(1);
  });

  it("201件のposts/placementsは全体を棄却する（トークン・メモリ防御）", () => {
    const manyPosts = Array.from({ length: 201 }, (_, i) => ({ code: `C-${i}`, zoneId: "main" }));
    const result = sanitizeDeploymentPlan({ posts: manyPosts, placements: [] });
    expect(result.posts).toEqual([]);
    expect(result.errors.some((e) => e.includes("200"))).toBe(true);
  });

  it("正常な入力は全てのplacementsが通り、名簿由来のrole/memberIdが付与される", () => {
    const result = sanitizeDeploymentPlan({
      posts: validPosts,
      placements: [{ name: "佐藤", postCode: "C-1" }],
    });
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0].memberId).toBe("s01");
    expect(result.placements[0].role).toBe("guide");
    expect(result.placements[0].zoneId).toBe("main");
    expect(result.rejected).toEqual({ posts: 0, placements: 0 });
  });
});

describe("sanitizePlacements — PATCH（postsを再送しない更新）で使う単独関数", () => {
  const posts: Post[] = [fakePost({ code: "C-1", zoneId: "main" }), fakePost({ code: "C-2", zoneId: "main" })];

  it("既存のposts配列に対してplacementsだけを検証できる", () => {
    const result = sanitizePlacements([{ name: "佐藤", postCode: "C-1" }], posts);
    expect(result.placements).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("postsに無いpostCodeは弾く", () => {
    const result = sanitizePlacements([{ name: "佐藤", postCode: "Z-9" }], posts);
    expect(result.placements).toEqual([]);
    expect(result.rejected).toBe(1);
  });
});

// ── 根本原因そのもののテスト ────────────────────────────────────

describe("根本原因のテスト: チケット数が変わってもposts凍結で孤児化しない", () => {
  // 実測（scratch probe, 2026-08-14）: DEFAULT_SCENARIOのpeakDensityはtickets=12000前後で
  // 早々に100%へ張り付くため、24000 vs 12000 では guide が両方7のまま変わらない。
  // guide=2（8000枚）と guide=7（24000枚）で確実にポスト列が変わる組み合わせを選ぶ。
  const TICKETS_LOW = 8000;
  const TICKETS_HIGH = 24000;

  it("postsFor(dayPlan({tickets:8000})) と {tickets:24000} でポスト列が変わる（前提の確認）", () => {
    const planA = dayPlan({ ...DEFAULT_SCENARIO, tickets: TICKETS_HIGH });
    const planB = dayPlan({ ...DEFAULT_SCENARIO, tickets: TICKETS_LOW });
    const postsA = postsFor(planA);
    const postsB = postsFor(planB);
    // 前提: guideの人数が変わりポスト列が変わる（変わらないならこのテストの意味がない）
    expect(postsA).not.toEqual(postsB);
  });

  it("確定計画のposts(=旧scenarioのスナップショット)を使う限り、新scenarioでポスト列が変わっても全placementが解決できる", () => {
    const planA = dayPlan({ ...DEFAULT_SCENARIO, tickets: TICKETS_HIGH });
    const postsA = postsFor(planA);

    // postsAの先頭3件に名簿の先頭3名を配置した確定計画を作る（凍結）
    const deployment = fakePlan({
      posts: postsA,
      placements: postsA.slice(0, 3).map((post, i) => ({
        memberId: ROSTER[i].id,
        name: ROSTER[i].name,
        role: post.role,
        postCode: post.code,
        zoneId: post.zoneId,
        fromHour: VENUE.open,
        toHour: VENUE.close,
      })),
    });
    expect(validatePlan(deployment)).toEqual({ ok: true, errors: [] });

    // scenarioが変わってpostsFor()の結果が変わっても、凍結されたdeployment.postsは無傷
    const planB = dayPlan({ ...DEFAULT_SCENARIO, tickets: TICKETS_LOW });
    const postsB = postsFor(planB);
    expect(postsB).not.toEqual(postsA);

    // 旧設計（毎回 postsFor() を再計算して参照する）ならここで孤児化するが、
    // 新設計は deployment.posts（凍結済み）をそのまま使うので全placementが引き続き解決できる
    expect(validatePlan(deployment)).toEqual({ ok: true, errors: [] });
    expect(deployment.placements.every((p) => deployment.posts.some((post) => post.code === p.postCode))).toBe(true);
  });
});
