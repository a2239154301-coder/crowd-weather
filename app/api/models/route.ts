import { NextResponse } from "next/server";
import { listModels, OrcaError } from "@/lib/ai/orca";

/**
 * OrcaRouterが実際に提供しているモデルIDの一覧。
 *
 * スポンサーdeckの記載（anthropic/claude-opus-5 等）と公式docsの記載
 * （anthropic/claude-sonnet-4.6 等）が食い違うため、モデルIDをコードに焼き込む前に
 * ここで実在確認する。ルーティング方針（lib/ai/orca.ts の ROUTING）を決める根拠になる。
 */
export async function GET() {
  try {
    const models = await listModels();
    return NextResponse.json({ count: models.length, models });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
