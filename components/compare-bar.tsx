"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "@/lib/ui/theme";

/**
 * 原案（Before）と改善案（After）を行き来するための帯。
 * 「どちらを見ているか」を常に明示する。比較が目的の画面なので、これは装飾ではない。
 *
 * ⚠ **ここに載せるのは"版"だけ**（2026-08-12）。
 * 一時 `/heatmap` を並べていたが、あれは同じ版の別の見せ方であって別の版ではない。
 * 予報コンソールと横並びに見えて「何が違うのか」が読めないという指摘を受けて外した。
 * 全画面表示へはコンソールの地図から入る。
 */

const PAGES: { href: string; tag: string; label: string; note: string }[] = [
  { href: "/original", tag: "原案", label: "馬場案 v1", note: "受領時のまま" },
  { href: "/original-v4", tag: "原案", label: "馬場案 v4", note: "暑熱エンジン・08-10" },
  { href: "/", tag: "改善案", label: "予報コンソール", note: "準備／当日／来場者" },
];

export default function CompareBar() {
  const { T } = useTheme();
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
        background: T.surface,
        border: `1px solid ${T.line}`,
        borderRadius: 11,
        marginBottom: 14,
      }}
    >
      <span style={{ fontSize: 13, color: T.textFaint, paddingRight: 4, letterSpacing: 1 }}>版</span>
      {PAGES.map((p) => {
        const current = path === p.href;
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={current ? "page" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              minHeight: 44,
              padding: "6px 12px",
              borderRadius: 8,
              textDecoration: "none",
              background: current ? T.text : "transparent",
              color: current ? T.page : T.textDim,
              border: `1px solid ${current ? T.text : T.line}`,
            }}
          >
            <span style={{ fontSize: 13, opacity: 0.75 }}>{p.tag}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
            <span style={{ fontSize: 13, opacity: 0.6 }}>{p.note}</span>
          </Link>
        );
      })}
    </nav>
  );
}
