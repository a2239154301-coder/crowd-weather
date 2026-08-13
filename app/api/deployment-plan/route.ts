import { NextResponse } from "next/server";
import {
  sanitizeDeploymentPlan,
  sanitizePlacements,
  validatePlan,
  type DeploymentPlan,
} from "@/lib/ops/deployment";
import { getConfirmedPlan, getDraftPlan, listDeploymentPlans, saveDeploymentPlan } from "@/lib/ops/store";

/**
 * 配置計画（DeploymentPlan）の永続化API。
 *
 * `app/api/assign/route.ts` が「提案（AI・計算どちらでも）」を返すだけなのに対し、
 * こちらは**承認された配置計画そのものを保存する**層。人間の承認フローの終着点
 * （CLAUDE.md改訂ルール「AIの行動は人間承認付きの提案まで」の「承認後」を担う）。
 *
 * ## posts は POST でしか受け付けない（凍結の実装）
 *
 * `DeploymentPlan.posts` は一度作られたら書き換えない設計（`lib/ops/deployment.ts` の
 * 冒頭コメント参照。孤児化根絶の本体）。そのため PATCH は `posts` を受け取らず、
 * 既存 plan の `posts`（凍結済み）に対して `placements` だけを再検証する
 * （`sanitizePlacements` を単独 export しているのはこのため）。
 *
 * ## 楽観ロック（version）
 *
 * `lib/ops/store.ts` の Upstash REST 経路は CAS が無く read-modify-write。
 * PATCH は `version` が現在値と一致するときだけ更新を許可し、不一致なら 409 で
 * **現行の plan を body に同梱**する（クライアントはこれを見て rebase できる）。
 *
 * ## confirm は draft→confirmed の一方向・確定後は placements 変更不可
 *
 * 確定済み計画の編集は「新しい draft を作る」操作であり、このAPIでは受け付けない
 * （このAPIは既存 plan の in-place 更新のみを扱う）。
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function GET() {
  const [draft, confirmed] = await Promise.all([getDraftPlan(), getConfirmedPlan()]);
  return NextResponse.json({ draft, confirmed });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sanitized = sanitizeDeploymentPlan(body);
  if (sanitized.errors.length > 0) {
    return NextResponse.json({ error: sanitized.errors.join(" / ") }, { status: 400 });
  }

  const now = Date.now();
  const plan: DeploymentPlan = {
    // POST は毎回まったく新しい plan（新しい id）を作る。newDraftFromAssignments の
    // `dp-${now}-1` 固定連番は「1回の呼び出しで1件」を前提にした純関数向けの割り切りだが、
    // このAPIは複数回呼ばれ得る永続化経路なので、既存のstore.ts add*系（r-/d-）と同じ
    // ランダムサフィックス方式でidの衝突を避ける
    id: `dp-${now}-${Math.floor(Math.random() * 1e6)}`,
    status: "draft",
    placements: sanitized.placements,
    posts: sanitized.posts,
    scenarioSnapshot: sanitized.scenarioSnapshot,
    version: 1,
    createdAt: now,
  };

  const check = validatePlan(plan);
  if (!check.ok) {
    return NextResponse.json({ error: check.errors.join(" / ") }, { status: 400 });
  }

  const saved = await saveDeploymentPlan(plan);
  if (!saved.ok) {
    // 新規id・expectedVersion未指定なので理論上到達しない（保存層の不変条件が破れた場合の防御）
    return NextResponse.json({ error: "計画の保存に失敗しました" }, { status: 500 });
  }

  return NextResponse.json({ plan: saved.plan });
}

type PatchBody = {
  id?: unknown;
  version?: unknown;
  placements?: unknown;
  status?: unknown;
};

export async function PATCH(req: Request) {
  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // id指定なので listDeploymentPlans() から直接探す（getDraftPlan/getConfirmedPlan は
  // それぞれ「最新1件」しか返さないため、20件保持しているうち古い方のidを対象にすると
  // 誤って404になる）
  const all = await listDeploymentPlans();
  const current = all.find((p) => p.id === id);
  if (!current) {
    return NextResponse.json({ error: "deployment plan not found" }, { status: 404 });
  }

  // version はここでは「読み取り時点」の粗い一致チェック（早期リターンでムダな検証を省く）。
  // 実際にlost updateを防ぐ最終防衛線は saveDeploymentPlan 内の再チェック
  const version = typeof body.version === "number" ? body.version : NaN;
  if (version !== current.version) {
    return NextResponse.json(
      { error: "バージョンが一致しません（他の変更が先に保存されています）", plan: current },
      { status: 409 }
    );
  }

  // 確定済み計画の placements は変更できない（確定計画の編集は新しい draft を作る操作であり、
  // このAPIでは受け付けない）
  if (current.status === "confirmed" && body.placements !== undefined) {
    return NextResponse.json({ error: "確定済みの配置計画の配置は変更できません" }, { status: 400 });
  }

  let nextPlacements = current.placements;
  if (body.placements !== undefined) {
    const result = sanitizePlacements(body.placements, current.posts);
    if (result.errors.length > 0) {
      return NextResponse.json({ error: result.errors.join(" / ") }, { status: 400 });
    }
    nextPlacements = result.placements;
  }

  let nextStatus = current.status;
  let confirmedAt = current.confirmedAt;
  if (body.status !== undefined) {
    if (body.status !== "confirmed") {
      return NextResponse.json({ error: 'status に指定できるのは "confirmed" のみです' }, { status: 400 });
    }
    if (current.status !== "draft") {
      return NextResponse.json({ error: "draft の計画だけが confirm できます" }, { status: 400 });
    }
    nextStatus = "confirmed";
    confirmedAt = Date.now();
  }

  const nextPlan: DeploymentPlan = {
    ...current,
    placements: nextPlacements,
    status: nextStatus,
    confirmedAt,
    version: current.version + 1,
  };

  const check = validatePlan(nextPlan);
  if (!check.ok) {
    return NextResponse.json({ error: check.errors.join(" / ") }, { status: 400 });
  }

  const saved = await saveDeploymentPlan(nextPlan, current.version);
  if (!saved.ok) {
    return NextResponse.json(
      { error: "バージョンが一致しません（他の変更が先に保存されています）", plan: saved.current },
      { status: 409 }
    );
  }

  return NextResponse.json({ plan: saved.plan });
}
