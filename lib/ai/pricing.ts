import type { OrcaMeta, OrcaUsage } from "./orca";

/**
 * LLM原価の円換算 — 審査項目⑥「実測原価の提示」の単一ソース。
 *
 * 実測なのは**トークン数**（OrcaRouterが全レスポンスで返す `usage`）。
 * 単価はゼロマークアップ（OrcaRouterは上流プロバイダの公表単価をそのまま通す）なので、
 * 各プロバイダの公表単価を掛ければ実費になる。この2つを混ぜて「全部実測」と
 * 言わないこと。画面では「トークン=実測 / 単価=公表値」と表記する。
 *
 * ⚠ 単価をLLMに推測させない。この表が唯一の出所。
 * ⚠ `ROUTING`（orca.ts）にモデルを足したら、ここにも単価を足す。
 *    漏れると pricing.test.ts が落ちる（意図的な仕組み）。
 */

/**
 * 円換算レート。概算表示用（2026-08時点の目安として150円/USDで固定）。
 * 原価は数円のオーダーなので、レートの±10%は表示上ほぼ効かない。
 */
export const USD_JPY = 150;

/** USD per 1M tokens */
export type ModelPrice = { inUsd: number; outUsd: number };

/**
 * ROUTING の全チェーン7モデルの公表単価（2026-08-12 記載）。
 *
 * 出典:
 * - Anthropic: haiku-4.5 = $1/$5, sonnet-4.6 = $3/$15（公式モデル表で確認済み 2026-08-12）
 * - OpenAI (openai.com/api/pricing): gpt-4o-mini = $0.15/$0.60, gpt-4o = $2.50/$10.00,
 *   gpt-4.1 = $2.00/$8.00
 * - Google (ai.google.dev/pricing): gemini-2.5-flash-lite = $0.10/$0.40,
 *   gemini-2.5-flash = $0.30/$2.50
 */
export const PRICES: Record<string, ModelPrice> = {
  "google/gemini-2.5-flash-lite": { inUsd: 0.1, outUsd: 0.4 },
  "google/gemini-2.5-flash": { inUsd: 0.3, outUsd: 2.5 },
  "openai/gpt-4o-mini": { inUsd: 0.15, outUsd: 0.6 },
  "openai/gpt-4o": { inUsd: 2.5, outUsd: 10.0 },
  "openai/gpt-4.1": { inUsd: 2.0, outUsd: 8.0 },
  "anthropic/claude-haiku-4.5": { inUsd: 1.0, outUsd: 5.0 },
  "anthropic/claude-sonnet-4.6": { inUsd: 3.0, outUsd: 15.0 },
};

/**
 * 1回の呼び出しの円換算。**未知のモデルは null**（誤った数字を出すより「—」）。
 */
export function costYen(model: string, usage: OrcaUsage | null): number | null {
  if (!usage) return null;
  const p = PRICES[model];
  if (!p) return null;
  const usd =
    (usage.prompt_tokens / 1_000_000) * p.inUsd +
    (usage.completion_tokens / 1_000_000) * p.outUsd;
  return usd * USD_JPY;
}

/**
 * meta から円換算。名前付きルーター経由（servedModel が `orcarouter/...`）のときは
 * 実際に解決されたモデル（X-Orca-Resolved-Model）の単価で計算する。
 */
export function costYenForMeta(
  meta: Pick<OrcaMeta, "servedModel" | "resolvedModel" | "usage">
): number | null {
  const model = meta.servedModel.startsWith("orcarouter/")
    ? (meta.resolvedModel ?? meta.servedModel)
    : meta.servedModel;
  return costYen(model, meta.usage);
}

/** 表示用。1円未満は小数2桁、それ以上は1桁 */
export function formatYen(yen: number | null): string {
  if (yen === null) return "—";
  return `¥${yen < 1 ? yen.toFixed(2) : yen.toFixed(1)}`;
}

/**
 * 1イベントの想定呼び出しプロファイル。
 * in/out トークンは実測値ベース（08-09〜12 の実運用ログとベンチの代表値）。
 */
export type EventProfileRow = {
  /** ROUTING のレーン */
  task: "ingest" | "plan" | "advice" | "whatif";
  /** 想定単価を引くモデル（各レーンの第一候補） */
  model: string;
  label: string;
  calls: number;
  inTok: number;
  outTok: number;
};

export const EVENT_PROFILE: EventProfileRow[] = [
  { task: "ingest", model: "openai/gpt-4.1", label: "会場資料の読解（会場ごと1回）", calls: 1, inTok: 2400, outTok: 4000 },
  { task: "plan", model: "anthropic/claude-sonnet-4.6", label: "計画書・総括の起草", calls: 3, inTok: 1000, outTok: 700 },
  { task: "advice", model: "google/gemini-2.5-flash-lite", label: "指示書・運営判断・ブリーフィング", calls: 10, inTok: 800, outTok: 350 },
  { task: "whatif", model: "openai/gpt-4.1", label: "What-if・ルート意図の解釈", calls: 5, inTok: 1300, outTok: 60 },
  { task: "advice", model: "google/gemini-2.5-flash-lite", label: "来場者ルートの説明文", calls: 20, inTok: 600, outTok: 150 },
];

export type EventCostRow = EventProfileRow & { yen: number };

/**
 * 1イベント運用の原価試算。行ごとの円と合計円。
 * 単価が引けない行があれば例外にする（試算表に「—」を混ぜない。表が嘘になる）。
 */
export function estimateEventCost(): { rows: EventCostRow[]; totalYen: number } {
  const rows = EVENT_PROFILE.map((r) => {
    const yen = costYen(r.model, {
      prompt_tokens: r.inTok * r.calls,
      completion_tokens: r.outTok * r.calls,
      total_tokens: (r.inTok + r.outTok) * r.calls,
    });
    if (yen === null) {
      throw new Error(`EVENT_PROFILE のモデル ${r.model} の単価が PRICES にありません`);
    }
    return { ...r, yen };
  });
  return { rows, totalYen: rows.reduce((a, r) => a + r.yen, 0) };
}
