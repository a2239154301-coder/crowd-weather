"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { INK } from "@/lib/forecast/scales";

/**
 * 原案（Before）と改善案（After）を行き来するための帯。
 * 「どちらを見ているか」を常に明示する。比較が目的の画面なので、これは装飾ではない。
 */

const PAGES: { href: string; tag: string; label: string; note: string }[] = [
  { href: "/original", tag: "原案", label: "馬場案 v1", note: "受領時のまま" },
  { href: "/original-v4", tag: "原案", label: "馬場案 v4", note: "暑熱エンジン・08-10" },
  { href: "/", tag: "改善案", label: "会場図＋日陰計算", note: "統合中" },
  { href: "/heatmap", tag: "改善案", label: "ヒートマップ試作", note: "太陽位置・風" },
];

export default function CompareBar() {
  const path = usePathname();
  return (
    <nav
      aria-label="版の切り替え"
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        alignItems: "center",
        padding: "8px 10px",
        background: INK.surface,
        border: `1px solid ${INK.line}`,
        borderRadius: 11,
        marginBottom: 14,
      }}
    >
      <span style={{ fontSize: 11, color: INK.textFaint, paddingRight: 4, letterSpacing: 1 }}>版</span>
      {PAGES.map((p) => {
        const current = path === p.href;
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={current ? "page" : undefined}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 7,
              padding: "6px 12px",
              borderRadius: 8,
              textDecoration: "none",
              background: current ? INK.text : "transparent",
              color: current ? INK.page : INK.textDim,
              border: `1px solid ${current ? INK.text : INK.line}`,
            }}
          >
            <span style={{ fontSize: 10, opacity: 0.75 }}>{p.tag}</span>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{p.label}</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{p.note}</span>
          </Link>
        );
      })}
    </nav>
  );
}
