import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { validateAssignments, type AssignmentContext } from "@/lib/ops/assign";
import type { Post } from "@/lib/ops/staffing";

/**
 * 初期配置案の起草 — 開場前の空席と候補者から「誰をどこへ配置するか」の**提案**を作る。
 *
 * ⚠ このAPIは提案を返すだけで、**配信はしない**。配信は調整コンソールの
 * 人間の承認ボタン → /api/dispatch だけが行う（Human-in-the-Loop。CLAUDE.md改訂ルール
 * 「AIの行動は人間承認付きの提案まで」）。/api/propose と同じ立場。
 *
 * ## なぜクライアントが AssignmentContext を送るのか
 *
 * `postsFor()`（staffing.ts）はクライアントの scenario に依存するため、サーバーは
 * 「空きポストがどこか」を自力で組み立てられない（/api/dispatch :70-72 の既知の制約と同じ
 * 事情）。したがってクライアントが `buildAssignmentContext()` の結果（candidates /
 * vacantPosts）をそのまま送る。
 *
 * これはクライアント由来の ctx が「何が正当か」を定義する形になるが、許容できる。理由:
 * 実際の配信は /api/dispatch が独立に検証しており（zoneId実在・スタッフ実在・
 * ポストコード書式）、このAPIは提案を返すだけで何も実行しない。ここで悪意ある ctx を
 * 送っても、その提案が承認されて /api/dispatch に渡るときに改めて弾かれる。
 *
 * ## 三重防御（/api/propose と同型）
 *  1. tool parameters の enum で提案先をリクエストの空きポスト・候補者名に限定（このファイル）
 *  2. サーバー側で validateAssignments を通す（enumをすり抜けた場合の最終防衛線。
 *     架空の名前・架空のポストコードの発番・二重割り当てを機械的に弾く）
 *  3. 検証ロジックそのものは lib/ops/assign.ts の validateAssignments を再利用する
 *     （ここで再実装しない。安全装置は1箇所に集約する）
 */

const MAX_ITEMS = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

type AssignRequestBody = {
  context?: {
    candidates?: unknown;
    vacantPosts?: unknown;
  };
  situation?: {
    hour?: unknown;
    timetable?: unknown;
    weather?: unknown;
    tempC?: unknown;
    ticketCount?: unknown;
  };
};

const ASSIGN_SYSTEM = `あなたはイベント警備の初期配置案を起草するアシスタントです。
候補者（空いているスタッフ）と空きポストから、開場前の配置案を作ってください。

- あなたの出力は提案であり、配信は人間の指示者が承認したときだけ行われる
- 役割一致を基本とする。ただし兼任は現場では普通なので、混雑や暑熱の状況次第で
  役割が違うポストに就けてもよい。その場合は理由に必ず書くこと
- 時間帯を考慮する: 開場前・開場直後は受付と入場ゲートを厚く、終演前は退場動線を厚く
- 暑い日は給水・救護を厚く
- 手薄になる場所を作らない
- トレードオフを隠さない。「安心」を書かない
  （※これは過去の事故への対策です。混雑指数100・警告つきの経路にLLMが
  「このルートは比較的空いています」と書いた事例があり、安全系の文言で「煽るな」だけを
  指示すると嘘をつく側に倒れることが分かっています。手薄になる場所があるなら、
  それを note に正直に書いてください）
- 各スタッフは1つのポストにだけ、各ポストには1人だけ割り当てる`;

export async function POST(req: Request) {
  let body: AssignRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.context || typeof body.context !== "object") {
    return NextResponse.json({ error: "context is required" }, { status: 400 });
  }

  const candidatesRaw = body.context.candidates;
  const vacantPostsRaw = body.context.vacantPosts;
  if (!Array.isArray(candidatesRaw) || !Array.isArray(vacantPostsRaw)) {
    return NextResponse.json(
      { error: "context.candidates と context.vacantPosts は配列である必要があります" },
      { status: 400 }
    );
  }
  if (candidatesRaw.length === 0 || vacantPostsRaw.length === 0) {
    return NextResponse.json({ error: "割り当てる候補（または空席）がありません" }, { status: 400 });
  }

  // 異常に大きい入力でトークンを溶かさない（悪意ある/壊れたクライアントへの防御）
  const ctx: AssignmentContext = {
    candidates: candidatesRaw.slice(0, MAX_ITEMS) as AssignmentContext["candidates"],
    vacantPosts: vacantPostsRaw.slice(0, MAX_ITEMS) as Post[],
  };

  const situation = isRecord(body.situation) ? body.situation : {};
  const situationForPrompt = {
    hour: typeof situation.hour === "string" ? situation.hour : "不明",
    timetable: typeof situation.timetable === "string" ? situation.timetable : undefined,
    weather: typeof situation.weather === "string" ? situation.weather : undefined,
    tempC: typeof situation.tempC === "number" ? situation.tempC : undefined,
    ticketCount: typeof situation.ticketCount === "number" ? situation.ticketCount : undefined,
  };

  // ⚠ LLMにポストコードを発番させない（このAPIの最重要要件）。
  // tool parameters の toPostCode / staffName をリクエストごとの動的enumにすることで、
  // モデルは「実在する空席」「実在する候補者」からしか選べなくなる。
  // enumがあっても保証はされない（すり抜けはあり得る）ため、下段のvalidateAssignmentsが
  // 最終防衛線として同じ集合で再検証する。
  const candidateNames = ctx.candidates.map((c) => String(c.name));
  const vacantPostCodes = ctx.vacantPosts.map((p) => String(p.code));

  const ASSIGN_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      assignments: {
        type: "array",
        maxItems: Math.min(candidateNames.length, vacantPostCodes.length),
        description: "配置案。各スタッフは1ポストにだけ、各ポストには1人だけ",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            staffName: { type: "string", enum: candidateNames, description: "配置するスタッフの名前（候補から選ぶ）" },
            toPostCode: { type: "string", enum: vacantPostCodes, description: "配置先のポストコード（空きポストから選ぶ）" },
            reason: { type: "string", description: "根拠。60字以内" },
          },
          required: ["staffName", "toPostCode", "reason"],
        },
      },
      note: { type: "string", description: "全体の補足（1文）。手薄になる場所があれば正直に書く" },
    },
    required: ["assignments", "note"],
  } as const;

  try {
    const { text, meta } = await callOrca({
      task: "advice",
      system: ASSIGN_SYSTEM,
      user: `候補者（空いているスタッフ）:\n${JSON.stringify(ctx.candidates, null, 2)}\n\n空きポスト:\n${JSON.stringify(ctx.vacantPosts, null, 2)}\n\n状況:\n${JSON.stringify(situationForPrompt, null, 2)}`,
      extras: {
        tool: {
          name: "propose_initial_assignment",
          description: "初期配置案を提出する（人間の承認後にのみ配信される）",
          parameters: ASSIGN_SCHEMA,
        },
        // advice既定の1500 tokenは、候補・空席とも上限100件（実運用は23名程度）を想定すると
        // 不足し得る。他の advice 呼び出し元（/api/propose）に影響させないため、
        // タスク既定は変えずこの呼び出しだけ上書きする
        maxTokens: 3000,
      },
    });

    let parsed: { assignments?: unknown; note?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "AIの提案を解釈できませんでした" }, { status: 502 });
    }

    // ⚠ validateAssignments は非配列を静かに空配列として扱う仕様なので、ここで明示的に
    // 分岐しないと「AIが提案ゼロ」と「AIが壊れた出力を返した」を呼び出し側が区別できない
    if (!Array.isArray(parsed.assignments)) {
      return NextResponse.json({ error: "AIの提案の形式が不正でした（assignmentsが配列ではありません）" }, { status: 502 });
    }

    const { assignments, rejected, warnings } = validateAssignments(parsed.assignments, ctx);

    return NextResponse.json({
      assignments,
      note: typeof parsed.note === "string" ? parsed.note : "",
      rejected,
      warnings,
      meta,
    });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
