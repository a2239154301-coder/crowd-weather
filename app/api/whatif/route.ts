import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";

/**
 * What-if 自然言語シナリオ。
 *
 * 「もし17時に雷雨が来たら？」のような自由文を、LLMが **Scenarioの差分JSON** に
 * 翻訳するだけのエンドポイント。混雑・WBGT・テント数の再計算はクライアント側の
 * 決定的なエンジンが行う。LLMは言語↔パラメータの翻訳機に徹する
 * （審査項目⑥「予報の計算そのものにLLMを使わない」を守ったままの自然言語操作）。
 *
 * ルーティングは advice と同じ軽量レーン（頻繁に叩かれる・出力が小さい）。
 */

// ⚠ union型（type: ["number","null"]）は使わない。GeminiのOpenAI互換層が
//   response_schema へ変換できず 400 になる（2026-08-11実測）。
//   「変更なし」はセンチネル値で表す: weather="keep" / 数値=-1。全プロバイダで安全。
const WHATIF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    changes: {
      type: "object",
      additionalProperties: false,
      description: "質問が意味する条件変更。変更しない項目は weather:'keep'、数値:-1",
      properties: {
        weather: {
          type: "string",
          enum: ["sunny", "cloudy", "rainy", "keep"],
          description:
            "天候の変更。雨・雷雨・豪雨・にわか雨は rainy、曇り・曇天は cloudy、晴れ・快晴・猛暑日は sunny。天候に言及がなければ keep",
        },
        temp: {
          type: "number",
          description: "予想最高気温℃（22-39）。「猛暑」「酷暑」は38。気温に言及がなければ -1",
        },
        rhPct: {
          type: "number",
          description: "湿度%（30-95）。「蒸し暑い」「多湿」は85前後。湿度に言及がなければ -1",
        },
        windMs: {
          type: "number",
          description: "風速m/s（0.2-5）。「無風」は0.2、「強風」は5。風に言及がなければ -1",
        },
        tickets: {
          type: "number",
          description:
            "チケット販売数（5000-40000）。「倍」「半分」等は現在値から計算した結果の数値を入れる。来場規模に言及がなければ -1",
        },
        hour: {
          type: "number",
          description: "質問が特定の時刻を指す場合、その時（11-21）。時刻に言及がなければ -1",
        },
      },
      required: ["weather", "temp", "rhPct", "windMs", "tickets", "hour"],
    },
    interpretation: {
      type: "string",
      description: "質問をどう解釈したかを日本語1文で",
    },
    feasible: {
      type: "boolean",
      description: "この質問がシナリオ変更として表現できるか。できなければ false",
    },
  },
  required: ["changes", "interpretation", "feasible"],
} as const;

const WHATIF_SYSTEM = `あなたはイベント予報シミュレータの入力インタフェースです。
ユーザーの「もし〜だったら?」という質問を、予報条件の変更値に変換してください。

- 変換だけを行う。予測・助言・計算はしない（それは計算エンジンの仕事）
- 変更しない項目には必ず「変更なし」の値を入れる: weather は "keep"、数値項目は -1
- 「雷雨」「ゲリラ豪雨」→ weather:"rainy"、「猛暑」「酷暑」→ tempを38前後に上げる、
  「無風」→ windMs:0.2、「倍の来場」→ ticketsを現在値の2倍（上限40000）のように解釈する
- 質問が時刻に触れていれば hour に入れる（11〜21の範囲。範囲外は最も近い端。指定なしは -1）
- 条件変更として表現できない質問（例「事故が起きたら」）は feasible:false にして、
  interpretation にその理由を書く

変換例:
質問「もし17時に雷雨が来たら?」
→ {"changes":{"weather":"rainy","temp":-1,"rhPct":-1,"windMs":-1,"tickets":-1,"hour":17},
   "interpretation":"17時の天候を雷雨（雨）に変更して再計算する。","feasible":true}
質問「猛暑で無風になったら?」
→ {"changes":{"weather":"sunny","temp":38,"rhPct":-1,"windMs":0.2,"tickets":-1,"hour":-1},
   "interpretation":"晴天のまま気温38℃・風速0.2m/sに変更して再計算する。","feasible":true}
質問「来場者が倍になったら?」（現在 tickets=24000 のとき）
→ {"changes":{"weather":"keep","temp":-1,"rhPct":-1,"windMs":-1,"tickets":40000,"hour":-1},
   "interpretation":"チケット販売数を2倍の48,000（上限40,000に丸め）へ変更して再計算する。","feasible":true}`;

export async function POST(req: Request) {
  let body: { question?: unknown; scenario?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.question || typeof body.question !== "string") {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  try {
    const { text, meta } = await callOrca({
      task: "whatif", // 翻訳専用レーン（flash-liteでは解釈漏れが出たため gpt-4o-mini）
      system: WHATIF_SYSTEM,
      user: `現在の予報条件:\n${JSON.stringify(body.scenario ?? {}, null, 2)}\n\n質問: ${body.question}`,
      extras: { jsonSchema: { name: "whatif", schema: WHATIF_SCHEMA } },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "AIの応答を解釈できませんでした" }, { status: 502 });
    }
    return NextResponse.json({ result: parsed, meta });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
