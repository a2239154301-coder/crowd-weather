import type { Metadata } from "next";
import OriginalV4 from "@/components/original-v4/mock";
import CompareBar from "@/components/compare-bar";
import { INK } from "@/lib/forecast/scales";

export const metadata: Metadata = {
  title: "馬場v4（暑熱エンジン統合版）｜CROWD WEATHER",
  description: "馬場氏が別リポジトリで進めた v4 を無改変で保存した比較用のページ",
};

export default function OriginalV4Page() {
  return (
    <div style={{ background: INK.page, minHeight: "100vh" }}>
      <div style={{ maxWidth: 1360, margin: "0 auto", padding: "18px 18px 0" }}>
        <CompareBar />
        <p
          style={{
            margin: "0 0 14px",
            padding: "11px 14px",
            background: INK.surface,
            border: `1px solid ${INK.line}`,
            borderLeft: `3px solid ${INK.textDim}`,
            borderRadius: 10,
            fontSize: 12.5,
            lineHeight: 1.8,
            color: INK.textDim,
          }}
        >
          <strong style={{ color: INK.text }}>これは馬場氏の v4 原本です。</strong>
          別リポジトリ（77taka777/crowd-weather-app・commit 2fe3379・2026-08-10）で進められた
          暑熱エンジン（NOAA太陽位置×影投影×WBGT物理）統合版を無改変で表示しています。
          物理エンジン・Open-Meteo実況・AIレイヤーは改善案側へ移植済み／移植中です。
        </p>
      </div>
      <OriginalV4 />
    </div>
  );
}
