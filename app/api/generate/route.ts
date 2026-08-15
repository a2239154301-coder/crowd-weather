import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";

/**
 * 馬場v4（/original-v4）互換のエンドポイント。
 *
 * v4 の AIレイヤータブは `POST /api/generate` に {prompt, strategy} を送る
 * （原本: 77taka777/crowd-weather-app の api/generate.js）。
 * 原本は `orcarouter/auto` を呼ぶが、auto は実測45.96秒（cheapest が推論モデルに
 * 解決した）だったため、こちらでは advice と同じ実測済みルーティングに乗せる。
 * 返り値の形（text / model / usage）は原本と同じに保つ。
 */
export async function POST(req: Request) {
  let body: { prompt?: unknown; strategy?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const rawPrompt = body?.prompt;
  if (!rawPrompt || typeof rawPrompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  // 入口で長さを切る。デモ用の合言葉はREADMEに公開しているため、
  // ゲートを通れる相手が任意長のプロンプトを流し込める状態にはしない
  // （正規の呼び出し元 /original-v4 は約700字なので実害なし）。
  const prompt = rawPrompt.slice(0, 4000);

  try {
    const { text, meta } = await callOrca({
      task: "advice",
      system:
        "あなたは CROWD WEATHER のAIレイヤーです。渡された数値をそのまま使い、簡潔で正確な日本語で答えてください。数値の捏造をしないこと。",
      user: prompt,
    });
    if (!text) {
      return NextResponse.json({ error: "empty response" }, { status: 502 });
    }
    return NextResponse.json({ text, model: meta.servedModel, usage: meta.usage });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
