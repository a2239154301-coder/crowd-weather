import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { PLAN_SYSTEM, adviceUserPrompt } from "@/lib/ai/prompts";

/**
 * 雑踏警備計画書の総括起草（LLM用途②）。
 *
 * イベントごとに数回しか呼ばれず、出力は警察・稟議向けの文書になるため、
 * 速度より文章品質を優先して plan タスク（上位モデル）に載せる。
 * 数値・配置は全てクライアント側の計算エンジンが出したものを渡す。
 */
export async function POST(req: Request) {
  let forecast: unknown;
  try {
    forecast = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { text, meta } = await callOrca({
      task: "plan",
      system: PLAN_SYSTEM,
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
