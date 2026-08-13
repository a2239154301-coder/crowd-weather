"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { useScenario } from "@/lib/ui/scenario-context";
import { dayPlan } from "@/lib/forecast/model";
import { postsFor, ROLE_LABEL, type Post, type PostRole } from "@/lib/ops/staffing";
import type { Dispatch, StaffState } from "@/lib/ops/store";

/**
 * スタッフ画面 — 名前で入場し、指示を受け、状況を報告する（スマホ前提・明色）。
 *
 * 設計原則（ユーザー要望 2026-08-13）:
 * - 状態は3つだけ（着任中/移動中/離脱中）。遷移は全部ワンタップ
 * - 報告は 混雑1-5・暑さ1-5 の大ボタン＋トラブル＋自由文
 * - 実際にその通り動けなくても混乱しないこと: この画面の申告は「最終申告＋時刻」として
 *   配置ボードに出るだけで、現実とズレたら指示者が手動補正する（現実が勝つ）
 *
 * 認証は名前ベース（localStorage保持）。本認証はロードマップ。
 */

type Me = { name: string; role: PostRole; postCode: string; zoneId: string; zoneName: string };

const LS_KEY = "cw-staff-me";
const POLL_MS = 5000;

export default function StaffConsole() {
  const { scenario } = useScenario();
  const posts = useMemo(() => postsFor(dayPlan(scenario)), [scenario]);

  const [me, setMe] = useState<Me | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [postSel, setPostSel] = useState("");
  const [state, setState] = useState<StaffState>("onpost");
  const [inbox, setInbox] = useState<Dispatch[]>([]);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [freeText, setFreeText] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 復帰（リロードしても入場し直さない）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setMe(JSON.parse(raw));
    } catch {
      /* 壊れた保存値は無視して入場からやり直す */
    }
  }, []);

  const say = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }, []);

  const syncMe = useCallback(
    async (m: Me, s: StaffState, note?: string) => {
      await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: m.name, role: m.role, postCode: m.postCode, zoneId: m.zoneId, state: s, note }),
      }).catch(() => say("通信できませんでした（電波を確認）"));
    },
    [say]
  );

  // 受信箱ポーリング
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/dispatch?name=${encodeURIComponent(me.name)}`);
        const data = await res.json();
        if (alive && Array.isArray(data.dispatches)) setInbox(data.dispatches);
      } catch {
        /* ポーリング失敗は次周期に任せる */
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [me]);

  async function enter() {
    const post = posts.find((p) => p.code === postSel);
    const name = nameInput.trim();
    if (!name || !post) return;
    const m: Me = { name, role: post.role, postCode: post.code, zoneId: post.zoneId, zoneName: post.zoneName };
    localStorage.setItem(LS_KEY, JSON.stringify(m));
    setMe(m);
    setState("onpost");
    await syncMe(m, "onpost");
  }

  async function transition(next: StaffState, note?: string) {
    if (!me) return;
    setState(next);
    await syncMe(me, next, note);
    say(next === "onpost" ? "着任を記録しました" : next === "moving" ? "移動中にしました" : "離脱を記録しました");
  }

  /** 指示への応答。moving=「移動します」/ arrived=「着きました」（着任先へ自分の配置を書き換える） */
  async function respond(d: Dispatch, status: "moving" | "arrived") {
    await fetch("/api/dispatch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: d.id, status }),
    });
    if (status === "moving") {
      await transition("moving");
    } else {
      const m: Me = { ...me!, zoneId: d.toZoneId, zoneName: d.toZoneName, postCode: d.fromCode ? `${d.fromCode}→` : me!.postCode };
      // 着任先が新しい持ち場になる。ポストコードは「元コード→」表記で移動履歴を残す
      localStorage.setItem(LS_KEY, JSON.stringify(m));
      setMe(m);
      setState("onpost");
      await syncMe(m, "onpost");
      say("着任を記録しました");
    }
    // 楽観更新（次のポーリングで正になる）
    setInbox((prev) => prev.map((x) => (x.id === d.id ? { ...x, status } : x)));
  }

  async function sendButtonReport(kind: "crowd" | "heat", level: number) {
    if (!me || sending) return;
    setSending(true);
    try {
      await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: me.name, zoneId: me.zoneId, kind, level }),
      });
      say(`${kind === "crowd" ? "混雑" : "暑さ"} ${level} を報告しました`);
    } finally {
      setSending(false);
    }
  }

  async function sendTrouble() {
    if (!me || sending) return;
    setSending(true);
    try {
      await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: me.name, zoneId: me.zoneId, kind: "trouble", level: 4 }),
      });
      say("トラブルを報告しました（詳細は自由文で）");
    } finally {
      setSending(false);
    }
  }

  async function sendFreeText() {
    if (!me || sending || !freeText.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: me.name, zoneId: me.zoneId, text: freeText }),
      });
      const data = await res.json();
      if (data.report) {
        say(`報告しました: ${data.report.summary}`);
        setFreeText("");
      } else {
        say(data.interpretation ?? "解釈できませんでした。ボタン報告も使ってください");
      }
    } finally {
      setSending(false);
    }
  }

  // ── 入場前 ──────────────────────────────────────────
  if (!me) {
    return (
      <div style={{ ...cardWrap, maxWidth: 420 }}>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>入場</div>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
          名前を入れて、割り当てられたポストを選んでください（配置は計画から自動生成）。
        </p>
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder="名前（例: 鈴木）"
          aria-label="名前"
          style={{ ...inputStyle, marginBottom: 8 }}
        />
        <select value={postSel} onChange={(e) => setPostSel(e.target.value)} aria-label="ポスト" style={{ ...inputStyle, marginBottom: 12 }}>
          <option value="">ポストを選ぶ</option>
          {posts.map((p: Post) => (
            <option key={p.code} value={p.code}>
              {p.code} {p.zoneName}・{ROLE_LABEL[p.role]}
            </option>
          ))}
        </select>
        <button onClick={enter} disabled={!nameInput.trim() || !postSel} style={primaryBtn}>
          このポストに着任する
        </button>
      </div>
    );
  }

  // ── 入場後 ──────────────────────────────────────────
  const active = inbox.filter((d) => d.status === "sent" || d.status === "moving");
  const stateLabel: Record<StaffState, string> = { onpost: "着任中", moving: "移動中", away: "離脱中" };

  return (
    <div style={{ ...cardWrap, maxWidth: 460 }}>
      {toast && (
        <div role="status" style={{ background: DAY.text, color: "#FFF", borderRadius: 10, padding: "10px 14px", fontSize: 15, marginBottom: 10 }}>
          {toast}
        </div>
      )}

      {/* 自分の配置 */}
      <div style={panel}>
        <div style={{ fontSize: 13, color: DAY.textFaint }}>あなたの配置（計画から）</div>
        <div style={{ fontSize: 19, fontWeight: 700, margin: "2px 0" }}>
          {me.name} — {me.zoneName}・{ROLE_LABEL[me.role]}
        </div>
        <div style={{ fontSize: 13, color: DAY.textDim }}>
          ポスト {me.postCode} ／ いま: <b style={{ color: DAY.text }}>{stateLabel[state]}</b>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <StateBtn label="着任中" active={state === "onpost"} onClick={() => transition("onpost")} />
          <StateBtn label="移動中" active={state === "moving"} onClick={() => transition("moving")} />
          <StateBtn label="離脱" active={state === "away"} onClick={() => transition("away", "休憩ほか")} />
        </div>
        <button
          onClick={() => {
            localStorage.removeItem(LS_KEY);
            setMe(null);
          }}
          style={{ ...ghostBtn, marginTop: 8, fontSize: 13 }}
        >
          入場し直す
        </button>
      </div>

      {/* 受信箱 */}
      <div style={panel}>
        <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 6 }}>受信箱（5秒ごとに更新）</div>
        {active.length === 0 && <div style={{ fontSize: 15, color: DAY.textDim }}>新しい指示はありません</div>}
        {active.map((d) => (
          <div
            key={d.id}
            style={{
              borderLeft: `5px solid ${d.urgency === "now" ? "#E5254A" : "#FB7A1E"}`,
              background: "#FDF3F5",
              borderRadius: "0 10px 10px 0",
              padding: "10px 12px",
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {d.toZoneName}へ{d.urgency === "now" ? "。いますぐ" : ""}
            </div>
            <div style={{ fontSize: 15, margin: "2px 0" }}>{d.action}</div>
            {d.reason && <div style={{ fontSize: 13, color: DAY.textDim }}>理由: {d.reason}</div>}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              {d.status === "sent" && (
                <button onClick={() => respond(d, "moving")} style={{ ...primaryBtn, flex: 1 }}>
                  移動します
                </button>
              )}
              <button onClick={() => respond(d, "arrived")} style={{ ...(d.status === "moving" ? primaryBtn : ghostBtn), flex: 1 }}>
                着きました
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 報告 */}
      <div style={panel}>
        <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 6 }}>
          いまの状況を報告（{me.zoneName}）
        </div>
        <ReportRow label="混雑" onPick={(n) => sendButtonReport("crowd", n)} disabled={sending} />
        <ReportRow label="暑さ" onPick={(n) => sendButtonReport("heat", n)} disabled={sending} />
        <button onClick={sendTrouble} disabled={sending} style={{ ...ghostBtn, width: "100%", marginTop: 6, borderColor: "#E5254A", color: DAY.danger }}>
          トラブル発生
        </button>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendFreeText()}
            placeholder="自由文でも報告できます（例: 列が折り返してる）"
            aria-label="自由文報告"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button onClick={sendFreeText} disabled={sending || !freeText.trim()} style={{ ...primaryBtn, whiteSpace: "nowrap" }}>
            送る
          </button>
        </div>
      </div>
    </div>
  );
}

function StateBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1,
        minHeight: 48,
        borderRadius: 10,
        border: `1px solid ${active ? DAY.text : DAY.line}`,
        background: active ? DAY.text : DAY.surface,
        color: active ? "#FFF" : DAY.text,
        fontSize: 15,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

/** 1-5 の大ボタン行。5=いますぐ対応が要る */
function ReportRow({ label, onPick, disabled }: { label: string; onPick: (n: number) => void; disabled: boolean }) {
  const colors = ["#22C55E", "#A3E635", "#FDE047", "#FB7A1E", "#E5254A"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
      <span style={{ width: 40, fontSize: 15, fontWeight: 700 }}>{label}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onPick(n)}
          disabled={disabled}
          aria-label={`${label}レベル${n}`}
          style={{
            flex: 1,
            minHeight: 48,
            borderRadius: 10,
            border: `2px solid ${colors[n - 1]}`,
            background: DAY.surface,
            color: DAY.text,
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

const cardWrap: React.CSSProperties = {
  background: DAY.page,
  color: DAY.text,
  borderRadius: 18,
  border: `1px solid ${DAY.line}`,
  padding: 14,
  margin: "0 auto",
  display: "grid",
  gap: 10,
};

const panel: React.CSSProperties = {
  background: DAY.surface,
  border: `1px solid ${DAY.line}`,
  borderRadius: 12,
  padding: "12px 14px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 48,
  padding: "0 12px",
  borderRadius: 10,
  border: `1px solid ${DAY.line}`,
  background: DAY.surface,
  color: DAY.text,
  fontSize: 15,
};

const primaryBtn: React.CSSProperties = {
  minHeight: 48,
  padding: "0 16px",
  borderRadius: 10,
  border: "none",
  background: DAY.text,
  color: "#FFF",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  minHeight: 44,
  padding: "0 14px",
  borderRadius: 10,
  border: `1px solid ${DAY.line}`,
  background: DAY.surface,
  color: DAY.text,
  fontSize: 15,
  cursor: "pointer",
};
