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

/** 画面の地色。validate_palette.js に渡した surface と同じ値を使うこと */
export const INK = {
  page: "#0A0E17",
  surface: "#121826",
  raised: "#182032",
  line: "#243149",
  hairline: "#1B2437",
  text: "#E8EEF9",
  textDim: "#93A3C0",
  textFaint: "#5D6C8A",
  accent: "#7DD3FC",
} as const;
