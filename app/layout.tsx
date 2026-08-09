import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CROWD WEATHER｜混雑は、予報できる。",
  description:
    "イベント会場の混雑と暑熱を時間帯別に予報し、雑踏警備計画書と人員配置を自動生成する。AI HACK 2026 / powered by OrcaRouter",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
