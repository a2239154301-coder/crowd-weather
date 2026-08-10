"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { INK } from "@/lib/forecast/scales";

function GateForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "合言葉が違います");
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        width: "min(360px, 90vw)",
        background: INK.surface,
        border: `1px solid ${INK.line}`,
        borderRadius: 14,
        padding: 26,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>CROWD WEATHER</div>
      <div style={{ fontSize: 12.5, color: INK.textDim, marginBottom: 18, lineHeight: 1.7 }}>
        審査・関係者向けのデモです。合言葉を入力してください。
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 9,
          border: `1px solid ${INK.line}`,
          background: INK.raised,
          color: INK.text,
          fontSize: 14,
        }}
      />
      {error && <div style={{ color: "#E5254A", fontSize: 12, marginTop: 8 }}>{error}</div>}
      <button
        type="submit"
        disabled={busy || !value}
        style={{
          marginTop: 14,
          width: "100%",
          padding: "11px 0",
          borderRadius: 10,
          border: "none",
          background: INK.text,
          color: INK.page,
          fontWeight: 700,
          fontSize: 13.5,
          cursor: busy ? "wait" : "pointer",
          opacity: busy || !value ? 0.6 : 1,
        }}
      >
        入る
      </button>
    </form>
  );
}

export default function GatePage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: INK.page,
        color: INK.text,
      }}
    >
      <Suspense fallback={null}>
        <GateForm />
      </Suspense>
    </div>
  );
}
