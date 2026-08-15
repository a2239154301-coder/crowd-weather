import { NextResponse } from "next/server";
import { callOrca, OrcaError, type OrcaTask } from "@/lib/ai/orca";
import {
  ADVICE_SYSTEM,
  DIRECTIVE_SYSTEM,
  ROUTE_SYSTEM,
  EASY_STYLE_INSTRUCTION,
  BRIEFING_SYSTEMS,
  adviceUserPrompt,
  type BriefingAudience,
} from "@/lib/ai/prompts";

/**
 * 予報値 → 運営の言葉への変換。
 *
 * 混雑指数・WBGT・日陰計算・配置最適化は **クライアント側の決定的な計算**で済ませ、
 * LLMは「数値を人が読んで判断できる言葉にする」ここでだけ使う（審査項目⑥の設計方針）。
 *
 * リクエスト形式（2026-08-11拡張・後方互換あり）:
 *   { mode?: "advice"|"directive", style?: "standard"|"easy",
 *     audience?: "responsible"|"staff"|"visitor", forecast: {...} }
 *   旧形式（bodyがそのまま予報データ）も受け付ける。
 *
 * モデルの振り分け（審査⑥のルーティング実演）:
 *   audience=responsible → plan タスク（上位モデル・意思決定向けの密度）
 *   それ以外            → advice タスク（軽量モデル・速度優先）
 */

// audience=responsible は plan タスク（上位モデル）へ載るため、planルートと同じ上限を持たせる。
export const maxDuration = 60;

type AdviceRequest = {
  mode?: "advice" | "directive" | "route";
  style?: "standard" | "easy";
  audience?: BriefingAudience;
  forecast?: unknown;
};

function isNewShape(body: Record<string, unknown>): boolean {
  return "forecast" in body || "mode" in body || "audience" in body;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed: AdviceRequest = isNewShape(body) ? (body as AdviceRequest) : { forecast: body };
  const forecast = parsed.forecast ?? body;

  // system プロンプトの組み立て: 基本形 → audience 上書き → 文体
  let system: string =
    parsed.mode === "directive"
      ? DIRECTIVE_SYSTEM
      : parsed.mode === "route"
        ? ROUTE_SYSTEM
        : ADVICE_SYSTEM;
  let task: OrcaTask = "advice";
  if (parsed.audience) {
    system = BRIEFING_SYSTEMS[parsed.audience] ?? system;
    if (parsed.audience === "responsible") task = "plan"; // 上位モデルへ
  }
  if (parsed.style === "easy") {
    system += EASY_STYLE_INSTRUCTION;
  }

  try {
    const { text, meta } = await callOrca({
      task,
      system,
      user: adviceUserPrompt(forecast),
    });
    return NextResponse.json({ text, meta });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
