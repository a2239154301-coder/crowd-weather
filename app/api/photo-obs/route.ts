import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";

/**
 * ゾーン写真 → 混雑レベル分類（写真ナウキャスト）。
 *
 * ⚠ **人数カウントはさせない**。Vision LLMの群集カウントは高密度で精度が出ない
 * というのが研究のコンセンサス（CrowdVLM-R1 2025等・調査08-13）。ここでは
 * スタッフのボタン報告と同じ**1-5の粗いレベル分類**だけを行い、結果は
 * 調整コンソールで**人間が確認してから**観測として採用する（自動では入れない）。
 * 定点カメラ＋専用モデル（CSRNet等）の実接続はロードマップ。
 *
 * LLMの役割は③観測の構造化（CLAUDE.md改訂ルール）。判断はしない。
 */

const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    crowdVisible: {
      type: "boolean",
      description: "群集・列・人の集まりが判定できる写真か。屋内・ブレ・無人なら false",
    },
    level: {
      type: "number",
      description:
        "混雑レベル1-5。1=まばら（すれ違い自由）、2=人はいるが自由に歩ける、3=歩速が落ちる・列が見える、4=密集・すり抜け困難、5=身動きが取りにくい密度。迷えば高い方（安全側）",
    },
    description: {
      type: "string",
      description: "何が見えるかの一言（日本語30字以内。例: 折り返した列が通路まで伸びている）",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "分類の確信度。画角が狭い・一部しか写っていない場合は low",
    },
  },
  required: ["crowdVisible", "level", "description", "confidence"],
} as const;

const PHOTO_SYSTEM = `あなたはイベント警備の現場写真の入力インタフェースです。
写真に写る群集の混雑レベルを1-5で分類してください。

- **人数を数えない**（写真からの人数カウントは不正確なので行わない設計）。粗いレベル分類だけを行う
- 分類だけを行う。危険かどうかの判断・対応の提案はしない（人間と計算エンジンの仕事）
- 迷ったら高いレベルに倒す（安全側）
- 群集が判定できない写真（無人・ブレ・風景のみ）は crowdVisible: false`;

export async function POST(req: Request) {
  let body: { imageDataUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const img = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
  if (!img.startsWith("data:image/")) {
    return NextResponse.json({ error: "imageDataUrl (data URI) is required" }, { status: 400 });
  }

  try {
    const { text, meta } = await callOrca({
      task: "ingest", // Vision必須なのでingestレーン（gpt-4.1）。分類だけなので出力は短い
      system: PHOTO_SYSTEM,
      user: "この写真の混雑レベルを分類してください。",
      extras: {
        imageDataUrl: img,
        jsonSchema: { name: "photo_crowd_level", schema: PHOTO_SCHEMA },
        maxTokens: 300,
        timeoutMs: 45_000,
      },
    });
    let parsed: { crowdVisible?: boolean; level?: number; description?: string; confidence?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "分類結果を解釈できませんでした" }, { status: 502 });
    }
    return NextResponse.json({
      result: {
        crowdVisible: parsed.crowdVisible === true,
        level: Math.max(1, Math.min(5, Math.round(parsed.level ?? 3))),
        description: (parsed.description ?? "").slice(0, 40),
        confidence: parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium",
      },
      meta,
    });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
