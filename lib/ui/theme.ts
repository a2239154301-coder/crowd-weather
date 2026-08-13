"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { INK } from "@/lib/forecast/scales";
import { DAY } from "./day-theme";

/**
 * 配色テーマの切替（2026-08-14 新設）。
 *
 * ## 経緯
 *
 * 08-14 に馬場氏レビュー項目1で全画面を明色化したが、氏の意図は
 * 「**スタッフ用画面などの背景色**」＝屋外で使う画面が主で、
 * **制作向け（計画モード）は原案v4の暗色のまま**という想定だった。
 * 明色化の成果を捨てずに両方を満たすため、切替可能にする。
 *
 * ## なぜ機械的に切り替えられるのか
 *
 * 原案v4のパレットと `INK` はほぼ同一（v4 ink #0A0F1E / INK page #0A0E17、
 * v4 panel #121A30 / INK surface #121826、v4 mist #EAF0FB / INK text #E8EEF9）。
 * つまり「v4に戻す」＝「`INK` に戻す」であり、明色化でやった `INK.`→`DAY.` の
 * 1:1置換（REDESIGN_08-14.md §1-3 の対応表）を逆向きに走らせるだけで済む。
 *
 * ## 屋外側を固定にしている理由
 *
 * 現場向け（当日モード）と来場者向けは**明色固定**。屋外・直射日光では暗色画面が
 * 最も読めない、という理由で明色にしてある（day-theme.ts 冒頭の設計判断）。
 * ここを暗くできるトグルを出すと、読めない配色を選べてしまう。
 * したがってトグルは**机上で見る2モード（制作向け・審査向け）にだけ**出す。
 */

export type ThemeName = "night" | "day";

/**
 * 暗色テーマ。
 *
 * `INK` は `lib/forecast/scales.ts`（凍結ファイル・予報計算の核）にあり直接足せないので、
 * 広げて不足キーを補う。補う2つの値は発明ではなく、明色化のときに置換した**逆写像**:
 *  - `danger` = `#FCA5A5` … 暗色時代の危険テキスト色。明色化で `DAY.danger` に替えた
 *    （`ops-console.tsx` / `ingest-panel.tsx` に「#FCA5A5 は白地1.69:1で判読不能」の記録が残っている）。
 *    暗色地 #121826 では 8.7:1
 *  - `accentSoft` = `#1D2B3B` … 従来 `${INK.accent}1A` と書いていたチップ地の実効値
 *    （#7DD3FC を10%で #121826 に重ねた結果）。アルファ連結をやめて実色で持つ
 */
export const NIGHT = {
  ...INK,
  danger: "#FCA5A5",
  accentSoft: "#1D2B3B",
} as const;

/**
 * `NIGHT` と `DAY` は同じキー集合を持つ（どちらも11キー）。片方だけにキーを足さないこと。
 *
 * `DAY`/`NIGHT` は `as const` でリテラル型なので `typeof DAY` をそのまま使うと
 * 「"#0A0E17" は "#EEF1F7" に代入できない」になる。キーの集合だけを借りて値は string に広げる。
 * **キーが片方にしか無ければここで型エラーになる**ので、ズレの検出器としても働く。
 */
export type Tokens = Record<keyof typeof DAY, string>;

const TOKENS: Record<ThemeName, Tokens> = { night: NIGHT, day: DAY };

/**
 * 段階色を**文字色**に使っている箇所の意味色。
 *
 * ここがテーマ切替で唯一「機械的にいかない」部分。明色化のとき、白地で読めない段階色
 * （`#FDE047` は白地 **1.32:1 で判読不能**）を墨色系へ振り替えた。
 * それを暗色地に戻すと今度は逆に読めなくなる（`#0F6E56` は暗色地で約2.5:1）。
 * したがって**テーマごとに値を持つ**必要がある。
 *
 * 塗り・ドット・帯には段階色そのもの（`DENSITY_BANDS` 等）を引き続き使う。
 * ここはあくまで「文字に使うとき」の代替色。
 */
export const SEMANTIC: Record<ThemeName, {
  /** 一次確認済み・良好・削減率などの「良い」文字色 */
  good: string;
  /** 二次資料・注意の文字色 */
  caution: string;
  /** 推定・弱い根拠の文字色 */
  weak: string;
}> = {
  day: { good: "#0F6E56", caution: "#B45309", weak: "#5A6685" },
  night: { good: "#22C55E", caution: "#FDE047", weak: "#FB923C" },
};

/**
 * モードごとの既定テーマ。
 * 机上で見るもの（制作・審査）＝暗色 ／ 屋外で見るもの（現場・来場者）＝明色。
 */
export const MODE_THEME: Record<string, ThemeName> = {
  plan: "night",
  judge: "night",
  live: "day",
  visitor: "day",
};

/** トグルを出してよいモード（＝既定が暗色で、明色にも切り替えられるもの） */
export function canToggleTheme(mode: string): boolean {
  return MODE_THEME[mode] === "night";
}

const STORAGE_KEY = "cw-theme-desk";

type ThemeValue = {
  name: ThemeName;
  /** 現在のテーマのトークン。`DAY.` を置き換える先 */
  T: Tokens;
  /** 現在のテーマの意味色 */
  sem: (typeof SEMANTIC)[ThemeName];
  /** このモードで切替できるか（屋外系は false） */
  canToggle: boolean;
  /** 机上系（制作・審査）のテーマを切り替える。屋外系には影響しない */
  toggle: () => void;
};

const ThemeCtx = createContext<ThemeValue | null>(null);

/**
 * `mode` を受けて既定を決め、机上系だけ localStorage の上書きを効かせる。
 *
 * SSRとの不一致を避けるため、**localStorage はマウント後に読む**
 * （`ops-console.tsx` の clockHour と同じ作法）。初回描画はモード既定で出る。
 */
export function useThemeState(mode: string): ThemeValue {
  const [deskOverride, setDeskOverride] = useState<ThemeName | null>(null);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === "night" || v === "day") setDeskOverride(v);
    } catch {
      /* localStorage が使えない環境ではモード既定のまま（機能を止めない） */
    }
  }, []);

  const canToggle = canToggleTheme(mode);
  const name: ThemeName = canToggle ? (deskOverride ?? MODE_THEME[mode] ?? "day") : "day";

  const toggle = useCallback(() => {
    setDeskOverride((prev) => {
      const cur = prev ?? "night";
      const next: ThemeName = cur === "night" ? "day" : "night";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* 保存できなくても切替自体は効かせる */
      }
      return next;
    });
  }, []);

  return useMemo(
    () => ({ name, T: TOKENS[name], sem: SEMANTIC[name], canToggle, toggle }),
    [name, canToggle, toggle]
  );
}

export const ThemeProvider = ThemeCtx.Provider;

/**
 * 配色トークンを取る。**Provider の外でも落ちない**（明色にフォールバックする）ので、
 * 単体で描画されるコンポーネント（`/heatmap` 等の独立ルート）から呼んでも安全。
 */
export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeCtx);
  if (ctx) return ctx;
  return { name: "day", T: DAY, sem: SEMANTIC.day, canToggle: false, toggle: () => {} };
}
