import type { Point } from "@/lib/forecast/types";
import { DEFAULT_SCENARIO, VENUE } from "@/lib/forecast/venue";
import { rosterByName, type RosterMember } from "@/lib/data/roster";
import { comparePostCode, type Assignment } from "./assign";
import { isValidZoneId, ROLE_LABEL, zoneById, type Post, type PostRole } from "./staffing";

/**
 * 配置計画（DeploymentPlan） — 永続化される「誰がどこに立つか」の唯一の正本。
 *
 * 2026-08-14 新設。これが解く問題:
 *
 * 従来、スタッフの配置は `lib/ops/store.ts` の `Staff.postCode` という**スカラー1個**しか
 * 持たなかった。「計画された配置」を保存する場所自体が存在しなかった。さらに
 * `postsFor(dayPlan(scenario))`（staffing.ts）は `scenario.tickets` に依存するため、
 * チケット数を変えると `plan.guide` が2〜7で動いて**ポスト列そのものが変わり**、
 * 着任済みスタッフが盤面から永久に消える（staffing.ts:101-110 のコメントがこの事故を
 * 認識している）。
 *
 * この根本原因は「配置の正しさを、毎回再計算されるポスト列に照会する」設計そのものにある。
 * `DeploymentPlan.posts` に **postsFor() の出力をそのままスナップショットとして凍結**する
 * ことで、この依存を断つ: 一度確定した計画は、後でシナリオ（チケット数・天候）が変わっても
 * 自分自身の `posts` を参照し続けるので、`placement.postCode` が解決できなくなることは
 * 二度と起きない（`lib/ops/deployment.test.ts` の「根本原因のテスト」参照）。
 *
 * ⚠ 依存方向の鉄則: このファイルは `lib/ops/store.ts` を import しない
 * （store側が `DeploymentPlan` 型を type-only import する片方向）。`Staff`/`Dispatch` を
 * 必要とする関数はここに置かない。`./assign` からの `comparePostCode` は値の再利用であり、
 * `assign.ts` の `store.ts` への依存は type-only（ランタイムでは消える）なので循環にならない。
 *
 * 全関数が純関数（`lib/ops/assign.ts` と同じ流儀）。LLMはここでは一切関与しない。
 */

export type Placement = {
  /** ROSTER の id */
  memberId: string;
  name: string;
  role: PostRole;
  postCode: string;
  zoneId: string;
  /**
   * 今は VENUE.open/close 固定（当面のUIはシフト編集を作らない）。
   * **シフト対応の受け皿として最初からフィールドだけ持たせておく**。
   */
  fromHour: number;
  toHour: number;
};

export type DeploymentPlan = {
  id: string;
  status: "draft" | "confirmed";
  placements: Placement[];
  /**
   * ★ポストコードの意味を凍結するスナップショット。
   * `postsFor()` を都度呼び直さず、常にこの配列だけを参照する。孤児化根絶の本体。
   */
  posts: Post[];
  scenarioSnapshot: { tickets: number; weather: string; temp: number };
  /**
   * 楽観ロック用のバージョン番号。`lib/ops/store.ts` の Upstash REST には CAS（Compare-And-Swap）
   * が無く read-modify-write になる。この番号で lost update（同時書き込みでの上書き消失）を
   * 検出できる（防げるわけではない。詳細は store.ts のコメント参照）。
   */
  version: number;
  createdAt: number;
  confirmedAt?: number;
};

// ── newDraftFromAssignments ─────────────────────────────────────

/**
 * `lib/ops/assign.ts` の `Assignment[]`（初期配置案）を `Placement[]` に変換し、
 * 新しい draft の DeploymentPlan を作る。
 *
 * `id` の連番は常に "1" 固定にしている: この関数は「1回の呼び出しで1つの新しい draft を作る」
 * ことだけを責務にした純関数で、過去に何個 draft を作ったかという状態を持たない
 * （持たせると呼び出し順に依存する副作用になり、「同じ入力なら常に同じ出力」という
 * 決定性のテストが成立しなくなる）。実運用で複数の draft が同一ミリ秒に作られる衝突は
 * デモ規模では実害が無いと判断した（`app/api/deployment-plan/route.ts` のPOSTは
 * ランダムサフィックス付きの別id生成を使っており、そちらが実際の永続化経路）。
 */
export function newDraftFromAssignments(
  assignments: Assignment[],
  posts: Post[],
  scenarioSnapshot: DeploymentPlan["scenarioSnapshot"],
  now: number
): DeploymentPlan {
  const placements: Placement[] = assignments.map((a) => ({
    memberId: a.memberId,
    name: a.name,
    role: a.role,
    postCode: a.toPostCode,
    zoneId: a.toZoneId,
    fromHour: VENUE.open,
    toHour: VENUE.close,
  }));

  return {
    id: `dp-${now}-1`,
    status: "draft",
    placements,
    // 複製する: 呼び出し元がその後 posts 配列を書き換えても、凍結済みのスナップショットは無傷
    posts: [...posts],
    scenarioSnapshot,
    version: 1,
    createdAt: now,
  };
}

// ── movePlacement ────────────────────────────────────────────────

export type MovePlacementResult =
  | { ok: true; plan: DeploymentPlan; swappedWith?: string }
  | { ok: false; reason: "unknown-post" | "same-post" | "unknown-member" };

/**
 * D&Dの中核。「1ポスト1人」を破らずに相手を黙って落とさないために、
 * 占有ポストへの移動は常にswap（入れ替え）を選ぶ。`assign.ts` の `planInitialAssignment` が
 * `unassigned`/`leftoverPosts` を返して「黙って落とさない」のと同じ安全側の原則。
 *
 * `plan.posts` に無いコードへの移動は拒否する（`unknown-post`）。これが孤児化根絶の
 * 実働部分: 凍結された posts の外側へは絶対に配置できない。
 *
 * 元の plan は破壊的変更しない（新しいオブジェクトを返す）。
 */
export function movePlacement(
  plan: DeploymentPlan,
  memberId: string,
  toPostCode: string
): MovePlacementResult {
  const moving = plan.placements.find((p) => p.memberId === memberId);
  if (!moving) return { ok: false, reason: "unknown-member" };

  const targetPost = plan.posts.find((p) => p.code === toPostCode);
  if (!targetPost) return { ok: false, reason: "unknown-post" };

  if (moving.postCode === toPostCode) return { ok: false, reason: "same-post" };

  const occupant = plan.placements.find((p) => p.postCode === toPostCode);

  const nextPlacements = plan.placements.map((p) => {
    if (p.memberId === moving.memberId) {
      return { ...p, postCode: targetPost.code, zoneId: targetPost.zoneId };
    }
    if (occupant && p.memberId === occupant.memberId) {
      return { ...p, postCode: moving.postCode, zoneId: moving.zoneId };
    }
    return p;
  });

  return {
    ok: true,
    plan: { ...plan, placements: nextPlacements },
    swappedWith: occupant?.memberId,
  };
}

// ── unassignPlacement ────────────────────────────────────────────

/** その人の placement を外す（駒箱へ戻す）。元の plan は破壊的変更しない。 */
export function unassignPlacement(plan: DeploymentPlan, memberId: string): DeploymentPlan {
  return { ...plan, placements: plan.placements.filter((p) => p.memberId !== memberId) };
}

// ── validatePlan ─────────────────────────────────────────────────

/**
 * DeploymentPlan の不変条件を検証する。`sanitizeDeploymentPlan` が「未検証の入力から
 * 安全なplanを組み立てる」層だとすれば、こちらは「既にできあがったplanが壊れていないか」
 * を確認する安全網（`movePlacement`/`unassignPlacement` のバグ・将来の変更に備える）。
 *
 * 1. 1メンバーにつき placement は最大1件
 * 2. 1ポストにつき placement は最大1件
 * 3. すべての placement.postCode が plan.posts に存在する（★孤児化根絶の本体）
 * 4. すべての post.zoneId が isValidZoneId() を通る
 * 5. VENUE.open <= fromHour < toHour <= VENUE.close
 */
export function validatePlan(plan: DeploymentPlan): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const memberIds = plan.placements.map((p) => p.memberId);
  const dupMemberIds = [...new Set(memberIds.filter((id, i) => memberIds.indexOf(id) !== i))];
  for (const id of dupMemberIds) {
    errors.push(`同じメンバー（${id}）に複数の配置があります`);
  }

  const postCodes = plan.placements.map((p) => p.postCode);
  const dupPostCodes = [...new Set(postCodes.filter((c, i) => postCodes.indexOf(c) !== i))];
  for (const code of dupPostCodes) {
    errors.push(`同じポスト（${code}）に複数人が割り当てられています`);
  }

  const postCodeSet = new Set(plan.posts.map((p) => p.code));
  for (const p of plan.placements) {
    if (!postCodeSet.has(p.postCode)) {
      errors.push(`${p.name}（${p.memberId}）の配置先 "${p.postCode}" は posts に存在しません`);
    }
  }

  for (const post of plan.posts) {
    if (!isValidZoneId(post.zoneId)) {
      errors.push(`ポスト ${post.code} のゾーンID "${post.zoneId}" は存在しません`);
    }
  }

  for (const p of plan.placements) {
    const inRange = VENUE.open <= p.fromHour && p.fromHour < p.toHour && p.toHour <= VENUE.close;
    if (!inRange) {
      errors.push(`${p.name} の勤務時間が不正です（${p.fromHour}〜${p.toHour}）`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── vacantPostsOf / unassignedMembers ─────────────────────────────

/** 誰も割り当たっていないポスト（コードの自然順）。 */
export function vacantPostsOf(plan: DeploymentPlan): Post[] {
  const taken = new Set(plan.placements.map((p) => p.postCode));
  return plan.posts.filter((p) => !taken.has(p.code)).slice().sort(comparePostCode);
}

/** placement を持たない名簿メンバー（ROSTER順）。 */
export function unassignedMembers(roster: RosterMember[], plan: DeploymentPlan): RosterMember[] {
  const assigned = new Set(plan.placements.map((p) => p.memberId));
  return roster.filter((m) => !assigned.has(m.id));
}

// ── sanitizeDeploymentPlan / sanitizePlacements ───────────────────

const POST_CODE_RE = /^[A-Z]-\d{1,2}$/;
const MAX_ITEMS = 200;
const POST_ROLES: readonly string[] = Object.keys(ROLE_LABEL);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}

function readNumber(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readPoint(rec: Record<string, unknown>, key: string): Point {
  const v = rec[key];
  if (isRecord(v) && typeof v.x === "number" && typeof v.y === "number") {
    return { x: v.x, y: v.y };
  }
  return { x: 0, y: 0 };
}

type SanitizePostsResult = { posts: Post[]; rejected: number; errors: string[] };

/**
 * `posts` 配列の防御的検証。サーバーは `postsFor()` を独自に再計算できない
 * （クライアントの scenario に依存するため。`app/api/assign/route.ts` の同種の制約と同じ事情）。
 * よってクライアントが送ってきた posts を検証だけして受け入れる。
 *
 * `role` は実在チェックの手段が無い（venueの実在ゾーンのようなマスタが無い）ため、
 * 不正値は棄却せず "guide" にフォールバックする（`app/api/staff/route.ts` の
 * 「role が不正なら guide にフォールバック」という既存の慣習を踏襲）。
 */
function sanitizePosts(raw: unknown): SanitizePostsResult {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push("posts は配列である必要があります");
    return { posts: [], rejected: 0, errors };
  }
  if (raw.length > MAX_ITEMS) {
    errors.push(`posts が上限（${MAX_ITEMS}件）を超えています（${raw.length}件）`);
    return { posts: [], rejected: raw.length, errors };
  }

  const posts: Post[] = [];
  let rejected = 0;
  const seenCodes = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) {
      rejected++;
      errors.push("posts に不正な要素があります（オブジェクトではありません）");
      continue;
    }
    const code = readString(item, "code");
    if (!POST_CODE_RE.test(code)) {
      rejected++;
      errors.push(`ポストコードの書式が不正です: "${code}"`);
      continue;
    }
    if (seenCodes.has(code)) {
      rejected++;
      errors.push(`postCode が重複しています: ${code}`);
      continue;
    }
    const zoneId = readString(item, "zoneId");
    if (!isValidZoneId(zoneId)) {
      rejected++;
      errors.push(`存在しないゾーンIDです: "${zoneId}"（ポスト ${code}）`);
      continue;
    }
    seenCodes.add(code);
    const zone = zoneById(zoneId)!;
    const roleRaw = readString(item, "role");
    const role = (POST_ROLES.includes(roleRaw) ? roleRaw : "guide") as PostRole;
    posts.push({
      code,
      zoneId,
      zoneName: readString(item, "zoneName") || zone.name,
      at: readPoint(item, "at"),
      role,
    });
  }

  return { posts, rejected, errors };
}

export type SanitizePlacementsResult = { placements: Placement[]; rejected: number; errors: string[] };

/**
 * `placements` 配列の防御的検証。`posts`（既に検証済み・または確定計画の凍結済み posts）
 * に対して照合する。`lib/ops/assign.ts` の `validateAssignments` と同じ思想:
 * **クライアントの自己申告（role・memberId・zoneId）を信用せず、名簿（ROSTER）と
 * posts から引き直す**。
 *
 * PATCH（`app/api/deployment-plan/route.ts`）は posts を再送させない
 * （確定計画の posts は凍結対象で書き換え不可）ため、`sanitizeDeploymentPlan` から
 * この関数だけを切り出して個別に export し、既存 plan の posts に対して
 * placements だけを検証できるようにしている。
 */
export function sanitizePlacements(raw: unknown, posts: Post[]): SanitizePlacementsResult {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push("placements は配列である必要があります");
    return { placements: [], rejected: 0, errors };
  }
  if (raw.length > MAX_ITEMS) {
    errors.push(`placements が上限（${MAX_ITEMS}件）を超えています（${raw.length}件）`);
    return { placements: [], rejected: raw.length, errors };
  }

  const postByCode = new Map(posts.map((p) => [p.code, p]));
  const placements: Placement[] = [];
  let rejected = 0;
  const seenMemberIds = new Set<string>();
  const seenCodes = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) {
      rejected++;
      errors.push("placements に不正な要素があります（オブジェクトではありません）");
      continue;
    }

    const name = readString(item, "name");
    const member = rosterByName(name);
    if (!member) {
      rejected++;
      errors.push(`名簿に無い名前です: "${name}"`);
      continue;
    }
    if (seenMemberIds.has(member.id)) {
      rejected++;
      errors.push(`同じメンバーが重複しています: ${member.name}`);
      continue;
    }

    const postCode = readString(item, "postCode");
    if (!POST_CODE_RE.test(postCode)) {
      rejected++;
      errors.push(`ポストコードの書式が不正です: "${postCode}"（${member.name}）`);
      continue;
    }
    const post = postByCode.get(postCode);
    if (!post) {
      rejected++;
      errors.push(`posts に存在しないポストコードです: "${postCode}"（${member.name}）`);
      continue;
    }
    if (seenCodes.has(postCode)) {
      rejected++;
      errors.push(`同じポストに複数人が割り当てられています: ${postCode}`);
      continue;
    }

    const fromHour = readNumber(item, "fromHour") ?? VENUE.open;
    const toHour = readNumber(item, "toHour") ?? VENUE.close;
    const inRange = VENUE.open <= fromHour && fromHour < toHour && toHour <= VENUE.close;
    if (!inRange) {
      rejected++;
      errors.push(`${member.name} の勤務時間が範囲外です（${fromHour}〜${toHour}）`);
      continue;
    }

    seenMemberIds.add(member.id);
    seenCodes.add(postCode);
    placements.push({
      // ⚠ memberId/role は raw の自己申告を使わず、名簿（唯一の正本）から引く
      memberId: member.id,
      name: member.name,
      role: member.role,
      // ⚠ zoneId も raw の自己申告を使わず、検証済み posts から引く
      postCode: post.code,
      zoneId: post.zoneId,
      fromHour,
      toHour,
    });
  }

  return { placements, rejected, errors };
}

export type SanitizedDeploymentInput = {
  posts: Post[];
  placements: Placement[];
  scenarioSnapshot: DeploymentPlan["scenarioSnapshot"];
  rejected: { posts: number; placements: number };
  errors: string[];
};

/**
 * サーバー側の入力検証の本体（`app/api/deployment-plan/route.ts` の POST が使う）。
 * `unknown` から防御的に読む。posts を先に検証してから、その posts に対して
 * placements を検証する（placements の zoneId・実在確認は posts 経由でしか行えない）。
 */
export function sanitizeDeploymentPlan(raw: unknown): SanitizedDeploymentInput {
  const rec = isRecord(raw) ? raw : {};

  const postsResult = sanitizePosts(rec.posts);
  const placementsResult = sanitizePlacements(rec.placements, postsResult.posts);

  const snapRaw = isRecord(rec.scenarioSnapshot) ? rec.scenarioSnapshot : {};
  const scenarioSnapshot = {
    tickets: readNumber(snapRaw, "tickets") ?? DEFAULT_SCENARIO.tickets,
    weather: readString(snapRaw, "weather") || DEFAULT_SCENARIO.weather,
    temp: readNumber(snapRaw, "temp") ?? DEFAULT_SCENARIO.temp,
  };

  return {
    posts: postsResult.posts,
    placements: placementsResult.placements,
    scenarioSnapshot,
    rejected: { posts: postsResult.rejected, placements: placementsResult.rejected },
    errors: [...postsResult.errors, ...placementsResult.errors],
  };
}
