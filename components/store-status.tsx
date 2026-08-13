"use client";

import { useEffect, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";

/**
 * 状態ストアの種別バッジ（2026-08-13 新設）。
 *
 * 本番URL（Vercel serverless）で in-memory のままスタッフ導線を使うと、
 * 関数インスタンスごとにメモリが分かれるため「入場したのに盤面に出ない」が
 * **エラーを出さずに**起きる。撮影・デモ前にここで気づけるようにする。
 * `GET /api/health` は種別と件数だけを返す（URL・トークン・合言葉の値は返さない）。
 */
type Health = { store: "upstash" | "memory"; persistent: boolean; gate: "on" | "off" };

export default function StoreStatus() {
  const [h, setH] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => alive && setH(d))
      .catch(() => {
        /* 表示しないだけ */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!h) return null;
  const ok = h.persistent;
  return (
    <span
      title={
        ok
          ? "Upstash に保存中。本番URLでもスタッフの入場・報告・指示が保持されます"
          : "メモリ保存です。本番URL（Vercel）ではスタッフ導線が安定しません。ローカルデモなら問題ありません"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${ok ? "#0F6E56" : "#B45309"}`,
        background: ok ? "#E9F8EF" : "#FFF3E4",
        color: ok ? "#0F6E56" : "#B45309",
        borderRadius: 999,
        padding: "3px 10px",
        fontSize: 13,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: "currentColor" }} />
      {ok ? "保存: Upstash（本番可）" : "保存: メモリ（ローカル用）"}
      {h.gate === "off" && (
        <span style={{ color: DAY.danger, fontWeight: 700 }}>／合言葉なし</span>
      )}
    </span>
  );
}
