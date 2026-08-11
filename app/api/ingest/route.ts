import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import {
  INGEST_JSON_SCHEMA,
  INGEST_SYSTEM,
  INGEST_USER,
  normalizeIngested,
  type IngestedVenue,
} from "@/lib/ai/ingest-schema";

/**
 * 会場資料（航空写真・会場図面）を読んで Venue 型のJSONを生成する。
 *
 * ここが「AIである必然性」の中核。
 * 会場資料は会場ごとに様式がバラバラで、ルールベースでは会場ごとに作り直しになる。
 * 2会場目以降の立ち上げコストを決めるのがこの読解であり、ここだけはLLMでないと成立しない。
 *
 * 呼び出しは**会場ごとに1回きり**。だから上位モデルを使っても1イベント当たりの原価はほぼ動かない。
 */

// Vercel Hobby の関数実行時間上限は60秒。ここを超える値を書いても効かないので合わせる。
// この60秒の中に「20秒×2候補のタイムアウト + 最終候補の応答 約9秒 + 前後処理」を収める設計にしている。
export const maxDuration = 60;

/**
 * json_schema を指定していてもモデルが ```json フェンスを付けて返すことがあるため、
 * 素の JSON.parse で失敗したら中括弧の範囲を切り出して再試行する。
 */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    try {
      return JSON.parse(stripped);
    } catch {
      const start = stripped.indexOf("{");
      const end = stripped.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
      throw new Error("no JSON object found");
    }
  }
}

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "画像を multipart/form-data で送ってください" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file がありません" }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json(
      { error: `対応していない形式です（${file.type}）。PNG / JPEG / WebP を使ってください` },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `画像が大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB）。8MB以下にしてください` },
      { status: 400 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type};base64,${buf.toString("base64")}`;

  try {
    const { text, meta } = await callOrca({
      task: "ingest",
      system: INGEST_SYSTEM,
      user: INGEST_USER,
      extras: {
        imageDataUrl: dataUrl,
        jsonSchema: { name: "venue", schema: INGEST_JSON_SCHEMA },
        // 60秒（maxDuration）の中で3候補のフォールバックまで走り切らせるための予算配分。
        // 20 + 20 + 9 ≈ 49秒 < 60秒。gpt-4.1 の実測は8〜12秒なので通常は1候補目で返る。
        // タイムアウトを大きくすると、候補が順に沈んだときVercelが先に関数を殺して502になる。
        timeoutMs: 20_000,
      },
    });

    let raw: IngestedVenue;
    try {
      raw = parseJsonLoose(text) as IngestedVenue;
    } catch {
      console.error("[ingest] JSONパース失敗", {
        model: meta.servedModel,
        length: text.length,
        head: text.slice(0, 300),
        tail: text.slice(-200),
      });
      return NextResponse.json(
        {
          error: "AIの応答をJSONとして読めませんでした。もう一度お試しください",
          debug: { length: text.length, head: text.slice(0, 300), tail: text.slice(-200) },
        },
        { status: 502 }
      );
    }

    // AIの出力をそのまま信用せず、地図として成立する形に正規化する
    const { venue, issues } = normalizeIngested(raw);

    return NextResponse.json({ venue, issues, meta });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
