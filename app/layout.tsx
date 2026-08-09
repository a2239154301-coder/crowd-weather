import type { Metadata } from "next";
import { IBM_Plex_Sans_JP, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/**
 * 画面の9割が日本語なので、日本語に書体を当てることを最優先にする。
 * IBM Plex Sans JP と IBM Plex Mono は同じスーパーファミリーで、
 * 和文・欧文・数字が同じ骨格で揃う。管制画面らしい「計器」の顔になる。
 */
const sans = IBM_Plex_Sans_JP({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "CROWD WEATHER｜混雑は、予報できる。",
  description:
    "イベント会場の混雑と暑熱を時間帯別に予報し、雑踏警備計画書と人員配置を自動生成する。AI HACK 2026 / powered by OrcaRouter",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
