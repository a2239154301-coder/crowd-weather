import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { ADVICE_SYSTEM, adviceUserPrompt } from "@/lib/ai/prompts";

/**
 * 原案モック（/original）が叩く旧エンドポイント。
 *
 * 比較ページを「AIボタンだけ動かない状態」にしないための互換ルート。
 * 中身は /api/advice と同じ callOrca を通すが、**旧モックが送ってくる payload には
 * 日陰率とピーク時刻が欠けている**（askOrca() が存在しない項目を参照しているため）。
 * つまりこのルートは、Before と After で「AIに渡る情報量」がどれだけ違うかも示している。
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
