import type { Metadata } from "next";
import HeatmapConsole from "@/components/heatmap-console";

export const metadata: Metadata = {
  title: "会場図（全画面）｜CROWD WEATHER",
  description: "予報コンソールと同じ条件で、リスク予報（危険までの残り時間）と暑さ指数の連続場を全画面で表示する",
};

export default function HeatmapPage() {
  return <HeatmapConsole />;
}
