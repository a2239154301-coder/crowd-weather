import type { Metadata } from "next";
import HeatmapConsole from "@/components/heatmap-console";

export const metadata: Metadata = {
  title: "ヒートマップ試作｜CROWD WEATHER",
  description: "日時・緯度経度・気温・湿度・雲量・風から、会場の暑さ指数を格子単位で計算する試作",
};

export default function HeatmapPage() {
  return <HeatmapConsole />;
}
