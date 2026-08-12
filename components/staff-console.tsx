"use client";

import { DAY } from "@/lib/ui/day-theme";

/**
 * スタッフ画面 — 名前で入場し、指示を受け、状況を報告する（新モード）。
 *
 * B工程（スタッフ縦串）で実装する。ここは画面骨格のプレースホルダ。
 * 実装内容: 名前＋役割で入場（localStorage）／ポストへの着任／受信箱（5秒ポーリング）／
 * 状態3つ（着任中・移動中・離脱中）のワンタップ遷移／混雑1-5・暑さ1-5の報告ボタン＋自由文。
 */
export default function StaffConsole() {
  return (
    <div
      style={{
        background: DAY.page,
        color: DAY.textDim,
        borderRadius: 16,
        border: `1px solid ${DAY.line}`,
        padding: 24,
        fontSize: 14,
        lineHeight: 1.8,
        maxWidth: 480,
        margin: "0 auto",
      }}
    >
      スタッフ画面（実装中）— 着任ポスト・指示の受信箱・1-5報告ボタンがここに入ります。
    </div>
  );
}
