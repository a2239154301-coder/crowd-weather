import type { Metadata } from "next";
import { Suspense } from "react";
import HeatmapConsole from "@/components/heatmap-console";
import { INK } from "@/lib/forecast/scales";

export const metadata: Metadata = {
  title: "会場図（全画面）｜CROWD WEATHER",
  description: "予報コンソールと同じ条件で、リスク予報（危険までの残り時間）と暑さ指数の連続場を全画面で表示する",
};

/**
 * HeatmapConsole は初期条件をURLクエリから読む（`useSearchParams`）。
 * 静的レンダリング時に Suspense 境界が要るのでここで包む（無いと `next build` が落ちる）。
 * fallback はプリレンダーHTMLそのものになるため地色を塗っておく
 */
export default function HeatmapPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: INK.page }} />}>
      <HeatmapConsole />
    </Suspense>
  );
}
