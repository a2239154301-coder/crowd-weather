import type { Metadata } from "next";
import OriginalMock from "@/components/original/mock";
import CompareBar from "@/components/compare-bar";
import { INK } from "@/lib/forecast/scales";

export const metadata: Metadata = {
  title: "原案（馬場案）｜CROWD WEATHER",
  description: "受領時のモックをそのまま保存した比較用のページ",
};

export default function OriginalPage() {
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
          <strong style={{ color: INK.text }}>これは原案です。</strong>
          馬場氏から受領した時点のコードを無改変で表示しています。改善案と見比べるためのもので、
          既知の不具合（AIに日陰率とピーク時刻が渡らない／フッターが別ハッカソン名のまま）も
          当時の状態を保つために直していません。
        </p>
      </div>
      <OriginalMock />
    </div>
  );
}
