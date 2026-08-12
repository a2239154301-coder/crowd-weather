import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { zonesFor } from "@/lib/forecast/venue";

/**
 * 来場者の自由文 → 経路探索の入力（出発地・目的地・優先条件）への翻訳。
 *
 * 「日陰を通って救護所に行きたい」「トイレ、混んでないところ」のような言い方を、
 * `findRoute()` が受け取れる3つの値に変換するだけのエンドポイント。
 * **経路そのものはダイクストラ法で決定的に計算する**（`lib/forecast/route.ts`）。
 * What-if（`/api/whatif`）と同じ「LLMは言語↔パラメータの翻訳機に徹する」型で、
 * 審査項目⑥「予報の計算そのものにLLMを使わない」を守ったまま自然言語で操作できる。
 *
 * 2026-08-12 新設。従来は出発地・行き先ともプルダウンで、
 * 行き先は救護・給水とトイレの2つしか選べなかった（`destinationsFor()`）。
 * 自由文にしたことで会場内の全ゾーンが行き先になる。
 *
 * ⚠ 変換結果は**クライアントで画面に出してから**経路計算に渡すこと。
 * 安全案内で解釈がブラックボックスだと、目的地を取り違えても来場者が気づけない。
 */

/** 選択肢はゾーンIDの列挙に固定する。自由文字列を返させると存在しないIDが来る */
const IN_ZONES = zonesFor("in");
const ZONE_IDS = IN_ZONES.map((z) => z.id);
const ZONE_GUIDE = IN_ZONES.map((z) => `${z.id}=${z.name}`).join(" / ");

// ⚠ union型（type: ["string","null"]）は使わない。GeminiのOpenAI互換層が
//   response_schema へ変換できず 400 になる（2026-08-11実測・whatif と同じ制約）。
//   「分からない」は understood:false で表す。
const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fromId: {
      type: "string",
      enum: ZONE_IDS,
      description: "いまいる場所のゾーンID。言及がなければ現在の設定値をそのまま返す",
    },
    toId: {
      type: "string",
      enum: ZONE_IDS,
      description: "行き先のゾーンID。「水」「休憩」「具合が悪い」は aid、「お手洗い」は wc",
    },
    preference: {
      type: "string",
      enum: ["safe", "cool", "short"],
      description:
        "優先条件。「混雑を避けたい」「人が少ない」→safe、「日陰」「涼しい」「暑い」→cool、「近い」「早い」「急ぐ」→short。言及がなければ safe",
    },
    interpretation: {
      type: "string",
      description: "どう解釈したかを日本語1文で。来場者にそのまま見せる",
    },
    understood: {
      type: "boolean",
      description: "会場内の移動の要望として解釈できたか。できなければ false",
    },
  },
  required: ["fromId", "toId", "preference", "interpretation", "understood"],
} as const;

const INTENT_SYSTEM = `あなたはイベント会場の経路案内の入力インタフェースです。
来場者の自由な言い方を、経路探索の入力値に変換してください。

会場内のゾーン（id=名前）: ${ZONE_GUIDE}

- 変換だけを行う。経路の提案・所要時間の推測・安全の判断はしない（それは計算エンジンの仕事）
- 体調や困りごとの表現は目的地に翻訳する:
  「水がほしい」「休みたい」「気分が悪い」「日射病かも」→ aid（救護・給水）
  「お手洗い」「トイレ」→ wc、「ごはん」「飲食」→ food、「グッズ」「物販」→ shop
  「出たい」「帰りたい」→ exit、「ステージが見たい」→ main
- 出発地の言及がなければ、渡された現在の設定値をそのまま fromId に入れる
- 優先条件の言及がなければ safe（混雑を避ける）にする
- 会場内の移動の要望として解釈できない入力（例「チケットを払い戻したい」）は
  understood:false にして、interpretation にその理由を書く

変換例:
入力「日陰を通って救護所に行きたい」（現在地 main のとき）
→ {"fromId":"main","toId":"aid","preference":"cool",
   "interpretation":"メインステージから救護・給水へ、日陰を優先して案内します。","understood":true}
入力「トイレ、混んでないところ」（現在地 food のとき）
→ {"fromId":"food","toId":"wc","preference":"safe",
   "interpretation":"フードコートからトイレへ、混雑を避けて案内します。","understood":true}
入力「西ゲートまで急いで」（現在地 main のとき）
→ {"fromId":"main","toId":"wg","preference":"short",
   "interpretation":"メインステージから西ゲートへ、最短距離で案内します。","understood":true}`;

export async function POST(req: Request) {
  let body: { question?: unknown; fromId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.question || typeof body.question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const currentFrom =
    typeof body.fromId === "string" && ZONE_IDS.includes(body.fromId) ? body.fromId : ZONE_IDS[0];

  try {
    const { text, meta } = await callOrca({
      task: "whatif", // 翻訳専用レーン（gpt-4.1・temperature 0）
      system: INTENT_SYSTEM,
      user: `現在の設定: いまいる場所=${currentFrom}\n\n来場者の入力: ${body.question}`,
      extras: { jsonSchema: { name: "route_intent", schema: INTENT_SCHEMA } },
    });

    let parsed: {
      fromId?: string;
      toId?: string;
      preference?: string;
      interpretation?: string;
      understood?: boolean;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "AIの応答を解釈できませんでした" }, { status: 502 });
    }

    // enum を付けていても保証はされない。存在しないIDは安全側に倒す
    const fromId = parsed.fromId && ZONE_IDS.includes(parsed.fromId) ? parsed.fromId : currentFrom;
    const toId = parsed.toId && ZONE_IDS.includes(parsed.toId) ? parsed.toId : null;
    const preference =
      parsed.preference === "cool" || parsed.preference === "short" || parsed.preference === "safe"
        ? parsed.preference
        : "safe";

    if (!toId || parsed.understood === false) {
      return NextResponse.json({
        result: {
          understood: false,
          interpretation:
            parsed.interpretation ?? "会場内の移動の要望として解釈できませんでした。",
        },
        meta,
      });
    }

    return NextResponse.json({
      result: {
        understood: true,
        fromId,
        toId,
        preference,
        interpretation: parsed.interpretation ?? "",
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
