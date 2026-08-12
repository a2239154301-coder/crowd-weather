/**
 * 較正層 — 混雑指数（0-100）に物理的な意味（人/m²・Fruin LOS帯）を与える。
 *
 * なぜこの層があるか:
 * アプリ内の危険帯閾値（指数75）は「体感的にヤバい」ではなく、群集安全の
 * 文献値（Fruin歩行路LOS・Stillのジャム密度）に接地していることを示すため。
 * ここも他の予報層と同じく**決定的な計算のみ**（LLM不使用）。
 * 数値は出典の確認度合いごとに ConfidenceTag を付け、UIの根拠セクションで
 * 「どこまで一次資料で確認できたか」を隠さず出す。
 */

import type { ZoneKind } from "./types";

/**
 * 出典の確認度。
 * - 一次確認済み: 原典そのものを確認した
 * - 二次資料: 信頼できる二次資料（教科書・レビュー論文等）で確認した
 * - 推定: 数値の出典を今回確認できておらず、慣用値からの推定
 */
export type ConfidenceTag = "一次確認済み" | "二次資料" | "推定";

/**
 * 指数100が何人/m²に相当するか（ゾーン種別ごとの較正定数）。
 *
 * なぜゾーン種別で分けるか: 同じ密度でも「立ち止まって待つ場」と
 * 「歩いて通り抜ける場」では危険の質が違う（Fruinも待機列と歩行路で
 * 別のLOS表を立てている）。較正のアンカーは危険帯閾値75:
 * - 滞留系: 75 → 5.5×0.75 ≈ 4.1人/m² ＝ Still (2000) のジャム密度4人/m²帯。
 *   ここを超えると群集が個々に動けなくなり、雪崩・転倒が起き始める
 * - 通路系: 75 → 2.7×0.75 ≈ 2.0人/m² ＝ Fruin歩行路LOS E/F境界（1.79人/m²）の帯。
 *   歩行流が崩壊し、通路が事実上の滞留に転じる領域
 * - 屋内系: 滞留系より低め（4.0）。壁に囲まれ逃げ場が少ないぶん、
 *   同じ指数でも低い密度で同等の危険とみなす
 */
export const INDEX100_PERSONS_PER_SQM: Record<ZoneKind, number> = {
  queue: 5.5,
  gate: 5.5,
  stage: 5.5, // 滞留系: 100 ≈ 5.5人/m²（危険帯75 ≈ 4.1 = Stillのジャム密度4人/m²帯）
  indoor: 4.0,
  aid: 4.0, // 屋内系: 100 ≈ 4.0
  corridor: 2.7,
  station: 2.7,
  alley: 2.7, // 通路系: 100 ≈ 2.7（危険帯75 ≈ 2.0 = Fruin歩行路LOS E/F境界1.79の帯）
};

/**
 * 混雑指数 → 推定密度（人/m²）。
 * 意図的に線形（index/100 × 較正定数）のまま丸めない。
 * 丸め・クランプは表示側（evidenceLabel）の責務に寄せ、
 * 計算層は可逆で検証しやすい形を保つ。
 */
export function personsPerSqm(kind: ZoneKind, index: number): number {
  return (index / 100) * INDEX100_PERSONS_PER_SQM[kind];
}

export type LosResult = {
  los: "A" | "B" | "C" | "D" | "E" | "F";
  confidence: ConfidenceTag;
};

/** 通路系＝歩行路LOSを適用するゾーン種別 */
const WALKWAY_KINDS: ReadonlySet<ZoneKind> = new Set(["corridor", "station", "alley"]);

/**
 * Fruin歩行路LOSの境界（人/m²）。
 * 原典は m²/人（12.08 / 3.72 / 2.23 / 1.39 / 0.56）で、その逆数を
 * 小数2〜3桁に丸めたもの: A≤0.083, B≤0.27, C≤0.45, D≤0.72, E≤1.79。
 * confidence は全帯 "二次資料"（B/C境界は資料間に食い違いがあり、
 * 原典の版差まで今回確認できていないため一律に落とす）。
 */
const WALKWAY_BOUNDS: { max: number; los: LosResult["los"] }[] = [
  { max: 0.083, los: "A" },
  { max: 0.27, los: "B" },
  { max: 0.45, los: "C" },
  { max: 0.72, los: "D" },
  { max: 1.79, los: "E" },
];

/**
 * 待機列LOSの境界（人/m²）と、その帯ごとの確認度。
 * A/B は二次資料で確認済み。C/D は Fruin原典の待機列C-F数値が
 * 今回未確認のため "推定" と正直に付ける。E/F の境界4.0人/m²は
 * Still (2000) のジャム密度に接地しており "二次資料"。
 * ＝帯ごとに確認度が違うので、境界と一緒にタグを持たせる設計にした
 */
const QUEUE_BOUNDS: { max: number; los: LosResult["los"]; confidence: ConfidenceTag }[] = [
  { max: 0.83, los: "A", confidence: "二次資料" },
  { max: 1.11, los: "B", confidence: "二次資料" },
  { max: 2.0, los: "C", confidence: "推定" },
  { max: 3.0, los: "D", confidence: "推定" },
  { max: 4.0, los: "E", confidence: "二次資料" },
];

/**
 * 密度（人/m²）→ LOS帯。
 * 通路系（corridor/station/alley）は歩行路LOS、それ以外は待機列LOSを適用。
 * 境界値ちょうどは下側の帯（≤判定）。
 */
export function losBand(kind: ZoneKind, ppsm: number): LosResult {
  if (WALKWAY_KINDS.has(kind)) {
    for (const b of WALKWAY_BOUNDS) {
      if (ppsm <= b.max) return { los: b.los, confidence: "二次資料" };
    }
    return { los: "F", confidence: "二次資料" };
  }
  for (const b of QUEUE_BOUNDS) {
    if (ppsm <= b.max) return { los: b.los, confidence: b.confidence };
  }
  return { los: "F", confidence: "二次資料" };
}

/**
 * 表示用ラベル。例: "≈4.1人/m²・LOS F相当"。
 * 「相当」を付けるのは、指数からの逆算値であって実測密度ではないため
 * （断定表記にすると根拠セクションの誠実さが崩れる）。小数1桁に丸める。
 */
export function evidenceLabel(kind: ZoneKind, index: number): string {
  const ppsm = personsPerSqm(kind, index);
  const { los } = losBand(kind, ppsm);
  return `≈${ppsm.toFixed(1)}人/m²・LOS ${los}相当`;
}

/**
 * 出典一覧（UIの根拠セクションが表示する）。
 * 較正の数字がどこから来たかを、確認度込みで利用者に開示する。
 * 「未確認」のものは未確認と書く — 安全計画の道具として、
 * 出典の格好つけより確認度の正直さを優先する。
 */
export const EVIDENCE_SOURCES: {
  claim: string;
  value: string;
  confidence: ConfidenceTag;
  source: string;
}[] = [
  {
    claim: "歩行路のサービス水準（LOS A-F）の密度境界",
    value: "A≤0.083 / B≤0.27 / C≤0.45 / D≤0.72 / E≤1.79 人/m²",
    confidence: "二次資料",
    source: 'J.J. Fruin "Pedestrian Planning and Design" (1971)。二次資料経由で確認',
  },
  {
    claim: "ジャム密度（群集が個々に動けなくなる密度）",
    value: "約4人/m²",
    confidence: "二次資料",
    source: "G.K. Still PhD thesis (2000)。二次資料経由で確認",
  },
  {
    claim: "群集乱流（crowd turbulence）の発生密度",
    value: "約6人/m²",
    confidence: "二次資料",
    source: "Helbing et al., Physical Review E (2007)。二次資料経由で確認",
  },
  {
    claim: "立見エリアの安全上限密度",
    value: "4.7人/m²",
    confidence: "二次資料",
    source: "英国 Guide to Safety at Sports Grounds（グリーンガイド）。二次資料経由で確認",
  },
  {
    claim: "明石歩道橋事故（2001年）の推定密度",
    value: "13人/m²超",
    confidence: "二次資料",
    source: "事故調査報告書 (2002)。二次資料経由で確認、報告書原本は未確認",
  },
  {
    claim: "警察庁通達「適切な雑踏警備の実施について」（令和5年）は手続き基準のみで、密度の数値基準を含まない",
    value: "密度の数値基準なし",
    confidence: "一次確認済み",
    source: "警察庁通達 令和5年。通達本文を確認済み",
  },
];
