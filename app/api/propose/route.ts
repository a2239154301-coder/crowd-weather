import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { isValidZoneId } from "@/lib/ops/staffing";
import { VENUE } from "@/lib/forecast/venue";

/**
 * AI配置提案 — 観測・予報・現在配置から「誰をどこへ動かすか」の**提案**を作る。
 *
 * ⚠ このAPIは提案を返すだけで、**配信はしない**。配信は調整コンソールの
 * 人間の承認ボタン → /api/dispatch だけが行う（Human-in-the-Loop。CLAUDE.md改訂ルール
 * 「AIの行動は人間承認付きの提案まで」）。
 *
 * 二重防御:
 *  1. JSON Schema の enum で提案先を実在18ゾーンに制限（このファイル）
 *  2. サーバー側で isValidZoneId を再検証（enumをすり抜けた場合の最終防衛線）
 *  （3. OrcaRouter Agent Firewall による gateway 側の検証 = 時間があれば追加）
 */

const ZONE_IDS = VENUE.zones.map((z) => z.id);
const ZONE_GUIDE = VENUE.zones.map((z) => `${z.id}=${z.name}`).join(" / ");

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposals: {
      type: "array",
      description: "配置変更の提案。0〜3件。動かす必要がなければ空配列",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          staffName: { type: "string", description: "動かすスタッフの名前（現在配置の一覧から選ぶ）" },
          fromCode: { type: "string", description: "現在のポストコード（例 A-1）" },
          toZoneId: { type: "string", enum: ZONE_IDS, description: "移動先ゾーン" },
          action: { type: "string", description: "現地でやること（例: 給水誘導・列の折返し整理）。30字以内" },
          urgency: { type: "string", enum: ["now", "soon"] },
          reason: { type: "string", description: "根拠。観測・予報の数値を引用する。60字以内" },
        },
        required: ["staffName", "fromCode", "toZoneId", "action", "urgency", "reason"],
      },
    },
    note: { type: "string", description: "提案全体の補足（1文）。提案ゼロならその理由" },
  },
  required: ["proposals", "note"],
} as const;

const PROPOSAL_SYSTEM = `あなたはイベント警備の配置提案アシスタントです。
観測（カメラ・スタッフ報告）と予報、現在の配置から、配置変更の**提案**を作ってください。

会場のゾーン（id=名前）: ${ZONE_GUIDE}

- あなたの出力は提案であり、配信は人間の指示者が承認したときだけ行われる
- 提案は最大3件。根拠には入力データの数値をそのまま引用する（創作しない）
- 手薄になる場所を作らない: 動かした後の元ポストのカバーも考慮する
- 危険度が高い順に対処する。全ゾーンが落ち着いていれば提案ゼロでよい（無理に作らない）`;

export async function POST(req: Request) {
  let body: { context?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.context || typeof body.context !== "object") {
    return NextResponse.json({ error: "context is required" }, { status: 400 });
  }

  try {
    const { text, meta } = await callOrca({
      task: "advice",
      system: PROPOSAL_SYSTEM,
      user: `現在の状況:\n${JSON.stringify(body.context, null, 2)}`,
      extras: { jsonSchema: { name: "dispatch_proposals", schema: PROPOSAL_SCHEMA } },
    });
    let parsed: {
      proposals?: {
        staffName: string;
        fromCode: string;
        toZoneId: string;
        action: string;
        urgency: string;
        reason: string;
      }[];
      note?: string;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "AIの提案を解釈できませんでした" }, { status: 502 });
    }

    // enumがあっても保証はされない。実在しないゾーンへの提案はここで落とす（検証の記録も返す）
    const raw = parsed.proposals ?? [];
    const proposals = raw.filter((p) => isValidZoneId(p.toZoneId));
    const rejected = raw.length - proposals.length;

    return NextResponse.json({
      proposals: proposals.slice(0, 3),
      note: parsed.note ?? "",
      rejected,
      meta,
    });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
