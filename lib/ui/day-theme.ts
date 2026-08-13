/**
 * 当日系画面（当日モード・スタッフ画面）の明色トークン。
 *
 * 2026-08-13、live-console.tsx にローカル定義していた `DAY` を共通化した。
 * 屋外・直射日光では暗色画面が最も読めないため、**当日系だけ明色**にする
 * （計画モードは事務所のPC想定なので暗色 `INK` のまま。フェーズで配色を分けるのは
 * ユーザー承認済みの設計判断 2026-08-13）。
 *
 * 全画面ライトモード化はチップの `${color}1A` 文字列連結の再設計が前提なので別作業。
 * `INK` には触れない。
 *
 * 段階色（DENSITY/WBGT/TIME_BANDS）は塗り・点・帯にだけ使い、
 * 明色地の文字は必ず墨色（text系）で書くこと（黄・橙の上の文字は読めない）。
 */
export const DAY = {
  page: "#EEF1F7",
  surface: "#FFFFFF",
  line: "#C9D2E4",
  text: "#0B111F",
  textDim: "#4A5670",
  /** コントラスト実測: 白地5.72:1・page地5.05:1（AA本文4.5:1を確保。#6C7891は4.44:1で未達だった） */
  textFaint: "#5A6685",
  /** 危険・警告の強調（明色地でコントラストが立つ濃赤） */
  danger: "#B3123A",
  /**
   * INK.raised の明色対応。白いカードの中の一段沈んだ面
   * （明色では「浮く」ではなく「沈む」で表す。page < surface の並びに対し raised は最も濃い）。
   * surface(#FFFFFF) 上で 1.21:1。**page(#EEF1F7) の上に直接置くと 1.07:1 でほぼ見えない**ので、
   * その場合は `border: 1px solid DAY.line` を併用すること。
   */
  raised: "#E3EAF6",
  /**
   * INK.hairline の明色対応。line より弱い区切り。
   * 暗色版の段差比（hairline は line の約40%の強さ）に合わせて算出:
   * 暗色 line 1.360 / hairline 1.143 → 明色 line 1.519 なので hairline は 1.23 前後が対応する。
   */
  hairline: "#E1E8F3",
  /** 選択中・操作の色（馬場氏「水色〜ブルー」）。明色地で文字に使える濃さが要る */
  accent: "#0B5C8C",
  /** accent の淡い塗り。チップ・選択行の背景に */
  accentSoft: "#E6F2FE",
} as const;

/**
 * 上部ナビ（ダークネイビー据置）の選択中タブの青。
 * 明色地ではなく INK.surface(#121826) の帯の上に置くため DAY.accent より明るい。
 * INK は凍結ファイル scales.ts にあるので、こちら側に持つ。
 */
export const NAV_ACCENT = "#2E7FC2";
