import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { ADVICE_SYSTEM, adviceUserPrompt } from "@/lib/ai/prompts";

/**
 * 予報値 → 運営判断の言語化。
 *
 * 混雑指数・WBGT・日陰計算・配置最適化は **クライアント側の決定的な計算**で済ませ、
 * LLMは「数値を人が読んで判断できる言葉にする」ここでだけ使う（審査項目⑥の設計方針）。
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
      task: "advice",
      system: ADVICE_SYSTEM,
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
