import type { Severity } from "./types";

/**
 * 段階色。**必ず band 名と一緒に表示する**（色だけで意味を運ばない）。
 *
 * 2026-08-09、dataviz の validate_palette.js で surface #121826 に対して検証済み:
 *   混雑 … 隣接ΔE 16.6（正常視）/ 8.9（色覚型・最悪tritan）
 *   暑熱 … 隣接ΔE 16.2（正常視）/ 8.6（色覚型・最悪deutan）
 * 数値を変えるときは必ず再検証すること。
 *
 * 2つの尺度は**同時に描かない**（レイヤ切替）。同時に出すと赤どうしが衝突する。
 */

export type Band = { severity: Severity; label: string; color: string; short: string };

/** 混雑指数（0-100）— 安全状態の語彙。警備会社が一目で読める緑→赤 */
export const DENSITY_BANDS: Band[] = [
  { severity: 0, label: "快適", short: "快", color: "#22C55E" },
  { severity: 1, label: "注意", short: "注", color: "#FDE047" },
  { severity: 2, label: "混雑", short: "混", color: "#FB7A1E" },
  { severity: 3, label: "危険", short: "危", color: "#E5254A" },
];

/** 暑さ指数 WBGT（℃）— 環境省の区分に準拠した4段階（公式配色そのものではない） */
export const WBGT_BANDS: Band[] = [
  { severity: 0, label: "涼", short: "涼", color: "#38BDF8" },
  { severity: 1, label: "警戒", short: "警", color: "#A3E635" },
  { severity: 2, label: "厳重警戒", short: "厳", color: "#FB923C" },
  { severity: 3, label: "危険", short: "危", color: "#EF4444" },
];

export function densityBand(v: number): Band {
  if (v < 25) return DENSITY_BANDS[0];
  if (v < 50) return DENSITY_BANDS[1];
  if (v < 75) return DENSITY_BANDS[2];
  return DENSITY_BANDS[3];
}

/** しきい値は環境省の暑さ指数の区分（25/28/31）に合わせている */
export function wbgtBand(v: number): Band {
  if (v < 25) return WBGT_BANDS[0];
  if (v < 28) return WBGT_BANDS[1];
  if (v < 31) return WBGT_BANDS[2];
  return WBGT_BANDS[3];
}

/**
 * 画面の地色。validate_palette.js に渡した surface と同じ値を使うこと。
 *
 * 2026-08-11 可読性改善: 「黒画面は格好いいが見づらい」という指摘を受け、
 * 補助テキスト2階層を明るくした（textDim #93A3C0→#A9B6D0 / textFaint #5D6C8A→#7A88A6）。
 * surface #121826 に対するコントラスト比: textDim 8.7:1 / textFaint 5.0:1（実測。従来のtextFaintは3.4:1でAA未達だった）。
 * 段階色（DENSITY/WBGT_BANDS）は変更していないため 08-09 のΔE検証がそのまま有効。
 */
export const INK = {
  page: "#0A0E17",
  surface: "#121826",
  raised: "#182032",
  line: "#243149",
  hairline: "#1B2437",
  text: "#E8EEF9",
  textDim: "#A9B6D0",
  textFaint: "#7A88A6",
  accent: "#7DD3FC",
} as const;
