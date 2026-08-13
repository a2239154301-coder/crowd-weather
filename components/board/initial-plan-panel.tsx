"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import SourceTag from "../source-tag";
import {
  buildAssignmentContext,
  planInitialAssignment,
  type Assignment,
} from "@/lib/ops/assign";
import { ROLE_LABEL, type Post } from "@/lib/ops/staffing";
import { postCodeLabel } from "@/lib/ops/board";
import { ROSTER } from "@/lib/data/roster";
import type { Dispatch, Staff } from "@/lib/ops/store";

/**
 * 初期配置案パネル — 「決定的な案を0msで出し、AIの案は後から追いつく」を体で示すUI。
 *
 * 2026-08-13 新設。開場前は名簿23名が全員未配置になる。指示者が1人ずつ
 * 「選ぶ→ゾーンをタップ→確認→配信」を23回繰り返すのは現実的でないため、
 * このパネルは配置案を**一括で作り、人間が承認して一斉配信する**。
 *
 * 設計の肝: `planInitialAssignment`（lib/ops/assign.ts・決定的計算・LLM不使用）を
 * ボタン押下と**同期**で実行し、即座に一覧を出す。`/api/assign`（AI起草）は
 * それと**同時に**投げるが、結果を待たずに操作を進められる状態にする。
 * AIが落ちても・遅くても、計算の案がそのまま現場で使える（＝現場が止まらない）ことが
 * このパネルの存在理由。AI案が届いたら「計算案との差分」だけを見せ、行単位で
 * 採否を選べるようにする（AIの提案を鵜呑みにしない・かといって全部は見せすぎない）。
 *
 * 配信は必ず /api/dispatch 一本を通す（新しいAPIを作らない）。1件ずつ逐次POSTし、
 * 部分失敗は握りつぶさず「失敗した分だけ残して再送」できるようにする
 * （Promise.all にすると、どれが失敗したか・順序がどうだったかが分からなくなる）。
 */

type Situation = {
  hour: string;
  timetable?: string;
  weather?: string;
  tempC?: number;
  ticketCount?: number;
};

type Props = {
  posts: Post[];
  staffList: Staff[];
  dispatches: Dispatch[];
  /** AIに渡す状況。親が scenario から組んで渡す */
  situation: Situation;
  /** 一斉配信が1件でも成功したら呼ぶ（親のポーリングを促す） */
  onDispatched?: () => void;
};

type CalcPlan = ReturnType<typeof planInitialAssignment>;

type AiStatus = "idle" | "loading" | "ok" | "error";

type AiResult = { assignments: Assignment[]; warnings: string[]; rejected: number; note: string };

/** 差分行。calc/ai のどちらか一方だけが存在するケースも表す（両方ともundefinedにはならない） */
type DiffRow = { name: string; calc?: Assignment; ai?: Assignment };

type DispatchRowState = { state: "sending" | "ok" | "failed"; error?: string };

/** AIタイムアウト。15秒待って戻ってこなければ「計算の案で進める」に切り替える */
const AI_TIMEOUT_MS = 15000;

/** モーダル内でフォーカスを受け取れる要素（staff-board.tsx の確認モーダルと同じ規約） */
const FOCUSABLE_SELECTOR = 'a[href], button, select, input, textarea, [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled")
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** ROSTER内の並び順（名簿の掲示順）で表示を安定させるための索引 */
const ROSTER_INDEX = new Map(ROSTER.map((m, i) => [m.name, i]));

export default function InitialPlanPanel({ posts, staffList, dispatches, situation, onDispatched }: Props) {
  const ctx = useMemo(
    () => buildAssignmentContext(ROSTER, posts, staffList, dispatches, Date.now()),
    [posts, staffList, dispatches]
  );
  const candidateCount = ctx.candidates.length;
  const vacantCount = ctx.vacantPosts.length;

  const disabledReasons: string[] = [];
  if (candidateCount === 0) disabledReasons.push("未配置のメンバーがいません");
  if (vacantCount === 0) disabledReasons.push("空席がありません");
  const planDisabled = disabledReasons.length > 0;

  const [calcPlan, setCalcPlan] = useState<CalcPlan | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus>("idle");
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiError, setAiError] = useState("");
  const [overrides, setOverrides] = useState<Map<string, "calc" | "ai">>(new Map());
  const [showCompare, setShowCompare] = useState(false);

  const [dispatchStatus, setDispatchStatus] = useState<Map<string, DispatchRowState>>(new Map());
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchProgress, setDispatchProgress] = useState<{ done: number; total: number } | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmItems, setConfirmItems] = useState<Assignment[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);

  // ── 配置案をつくる（計算=同期／AI=非同期・15秒タイムアウト） ──────────────
  const handlePlanClick = useCallback(() => {
    const plan = planInitialAssignment(ctx);
    setCalcPlan(plan);
    setOverrides(new Map());
    setShowCompare(false);
    setAiResult(null);
    setAiError("");
    setAiStatus("loading");
    setDispatchStatus(new Map());
    setDispatchProgress(null);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    (async () => {
      try {
        const res = await fetch("/api/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context: ctx, situation }),
          signal: controller.signal,
        });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok || !isRecord(data)) {
          setAiStatus("error");
          setAiError("AIの案は取得できませんでした（計算の案で進めます）");
          return;
        }
        const assignments = Array.isArray(data.assignments) ? (data.assignments as Assignment[]) : [];
        const warnings = Array.isArray(data.warnings)
          ? data.warnings.filter((w): w is string => typeof w === "string")
          : [];
        const rejected = typeof data.rejected === "number" ? data.rejected : 0;
        // note は「手薄になる場所があれば正直に書く」担当（/api/assign のsystem prompt参照）。
        // 黙って隠さない原則はwarnings/rejectedだけでなくここにも及ぶ
        const note = typeof data.note === "string" ? data.note : "";
        setAiResult({ assignments, warnings, rejected, note });
        setAiStatus("ok");
      } catch {
        // AbortError（タイムアウト）も通信エラーも同じ扱い。操作は止めない
        setAiStatus("error");
        setAiError("AIの案は取得できませんでした（計算の案で進めます）");
      } finally {
        clearTimeout(timer);
      }
    })();
  }, [ctx, situation]);

  // ── 差分（計算案 vs AI案） ────────────────────────────────────────────
  const diffRows: DiffRow[] = useMemo(() => {
    if (!calcPlan || !aiResult) return [];
    const calcByName = new Map(calcPlan.assignments.map((a) => [a.name, a]));
    const aiByName = new Map(aiResult.assignments.map((a) => [a.name, a]));
    const names = new Set<string>([...calcByName.keys(), ...aiByName.keys()]);
    const rows: DiffRow[] = [];
    for (const name of names) {
      const c = calcByName.get(name);
      const a = aiByName.get(name);
      // 同じtoPostCodeでない（片方が居ない場合も含む）なら差分
      if (c?.toPostCode !== a?.toPostCode) rows.push({ name, calc: c, ai: a });
    }
    rows.sort((x, y) => (ROSTER_INDEX.get(x.name) ?? 999) - (ROSTER_INDEX.get(y.name) ?? 999));
    return rows;
  }, [calcPlan, aiResult]);

  const setOverride = useCallback((name: string, choice: "calc" | "ai") => {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(name, choice);
      return next;
    });
  }, []);

  // ── 最終的な配信対象（既定=計算案。差分行だけ上書き可） ────────────────────
  const finalAssignments: Assignment[] = useMemo(() => {
    if (!calcPlan) return [];
    const byName = new Map(calcPlan.assignments.map((a) => [a.name, a]));
    for (const row of diffRows) {
      const choice = overrides.get(row.name) ?? "calc";
      if (choice === "ai") {
        if (row.ai) byName.set(row.name, row.ai);
        else byName.delete(row.name);
      } else {
        if (row.calc) byName.set(row.name, row.calc);
        else byName.delete(row.name);
      }
    }
    const list = [...byName.values()];
    list.sort((x, y) => (ROSTER_INDEX.get(x.name) ?? 999) - (ROSTER_INDEX.get(y.name) ?? 999));
    return list;
  }, [calcPlan, diffRows, overrides]);

  /**
   * 計算案とAI案は同じ vacantPosts から**独立に**選んでいるため、差分行だけAI案へ
   * 個別に切り替えると、AIが選んだポストが「計算案のまま残した別の人」のポストと
   * 衝突することがありうる（validateAssignmentsはAI提案内部の重複しか弾かない。
   * この画面でのマージが生む重複はここでしか検知できない）。
   * 見落として配信すると同じポストに2人送る事故になるため、検出して配信をブロックする。
   */
  const duplicatePostCodes = useMemo(() => {
    const byCode = new Map<string, string[]>();
    for (const a of finalAssignments) {
      const arr = byCode.get(a.toPostCode) ?? [];
      arr.push(a.name);
      byCode.set(a.toPostCode, arr);
    }
    return [...byCode.entries()].filter(([, names]) => names.length > 1);
  }, [finalAssignments]);

  // ── 一斉配信（確認モーダル→ /api/dispatch を1件ずつ逐次） ───────────────
  const runDispatch = useCallback(
    async (items: Assignment[]) => {
      if (items.length === 0) return;
      setDispatchBusy(true);
      setDispatchProgress({ done: 0, total: items.length });
      let anyOk = false;
      const next = new Map(dispatchStatus);

      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        next.set(a.name, { state: "sending" });
        setDispatchStatus(new Map(next));
        try {
          const res = await fetch("/api/dispatch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              staffName: a.name,
              fromCode: a.fromCode,
              toZoneId: a.toZoneId,
              toPostCode: a.toPostCode,
              action: "配置についてください",
              urgency: "soon",
              reason: a.reason,
            }),
          });
          let data: unknown = null;
          try {
            data = await res.json();
          } catch {
            data = null;
          }
          if (!res.ok) {
            const errMsg = isRecord(data) && typeof data.error === "string" ? data.error : `エラー（${res.status}）`;
            next.set(a.name, { state: "failed", error: errMsg });
          } else {
            next.set(a.name, { state: "ok" });
            anyOk = true;
          }
        } catch {
          next.set(a.name, { state: "failed", error: "通信エラー" });
        }
        setDispatchStatus(new Map(next));
        setDispatchProgress({ done: i + 1, total: items.length });
      }

      setDispatchBusy(false);
      if (anyOk) onDispatched?.();
    },
    [dispatchStatus, onDispatched]
  );

  /**
   * 「一斉に配信」の対象は、すでに配信成功（ok）した分を除く。
   * 除かないと、成功後にもう一度同じボタンを押すと同じ人へ二重に指示が飛ぶ
   * （失敗分だけの再送は専用ボタンがあるので、ここでは「まだ成功していない分」だけを対象にする）
   */
  const pendingAssignments = useMemo(
    () => finalAssignments.filter((a) => dispatchStatus.get(a.name)?.state !== "ok"),
    [finalAssignments, dispatchStatus]
  );

  const openConfirm = useCallback(() => {
    if (pendingAssignments.length === 0 || dispatchBusy || duplicatePostCodes.length > 0) return;
    setConfirmItems(pendingAssignments);
    setConfirmOpen(true);
  }, [pendingAssignments, dispatchBusy, duplicatePostCodes]);

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  const handleConfirmDispatch = useCallback(() => {
    setConfirmOpen(false);
    void runDispatch(confirmItems);
  }, [confirmItems, runDispatch]);

  const failedAssignments = useMemo(
    () => finalAssignments.filter((a) => dispatchStatus.get(a.name)?.state === "failed"),
    [finalAssignments, dispatchStatus]
  );

  const handleResend = useCallback(() => {
    if (failedAssignments.length === 0 || dispatchBusy) return;
    void runDispatch(failedAssignments);
  }, [failedAssignments, dispatchBusy, runDispatch]);

  // ── 確認モーダルのフォーカス出入り（staff-board.tsx の確認モーダルと同じ規約） ─────
  useEffect(() => {
    if (!confirmOpen) return;
    const prev = document.activeElement;
    focusablesIn(modalRef.current)[0]?.focus();
    return () => {
      if (prev instanceof HTMLElement || prev instanceof SVGElement) prev.focus();
    };
  }, [confirmOpen]);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeConfirm();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusablesIn(modalRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = modalRef.current?.contains(active) ?? false;
      const atEdge = e.shiftKey ? active === first : active === last;
      if (atEdge || !inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, closeConfirm]);

  const dispatchDone = dispatchStatus.size > 0 && !dispatchBusy;
  const dispatchOkCount = [...dispatchStatus.values()].filter((s) => s.state === "ok").length;

  return (
    <div style={{ background: DAY.surface, border: `1px solid ${DAY.line}`, borderRadius: 12, padding: "12px 14px", display: "grid", gap: 10 }}>
      {!calcPlan && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: DAY.text }}>
            未配置 <span className="cw-mono">{candidateCount}</span>名・空席 <span className="cw-mono">{vacantCount}</span>
          </span>
          <button
            onClick={handlePlanClick}
            disabled={planDisabled}
            title={planDisabled ? disabledReasons.join("／") : undefined}
            style={{
              minHeight: 44,
              padding: "0 16px",
              borderRadius: 9,
              border: "none",
              background: planDisabled ? "#93A3C0" : DAY.text,
              color: "#FFF",
              fontSize: 15,
              fontWeight: 700,
              cursor: planDisabled ? "not-allowed" : "pointer",
            }}
          >
            配置案をつくる
          </button>
          {planDisabled && <span style={{ fontSize: 13, color: DAY.textDim }}>{disabledReasons.join("／")}</span>}
        </div>
      )}

      {calcPlan && (
        <>
          {/* ── 見出し + 一斉配信ボタン ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44 }}>
            <SourceTag kind="calc" tone="day" />
            <span style={{ fontSize: 19, fontWeight: 700, color: DAY.text }}>
              {calcPlan.assignments.length}件の配置案
            </span>
            <button
              onClick={openConfirm}
              disabled={pendingAssignments.length === 0 || dispatchBusy || duplicatePostCodes.length > 0}
              style={{
                marginLeft: "auto",
                minHeight: 44,
                padding: "0 16px",
                borderRadius: 9,
                border: "none",
                background:
                  pendingAssignments.length === 0 || dispatchBusy || duplicatePostCodes.length > 0
                    ? "#93A3C0"
                    : DAY.text,
                color: "#FFF",
                fontSize: 15,
                fontWeight: 700,
                cursor:
                  pendingAssignments.length === 0 || dispatchBusy || duplicatePostCodes.length > 0
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              一斉に配信（{pendingAssignments.length}件）
            </button>
          </div>

          {/* 計算案とAI案を行単位で混ぜた結果、同じポストに2人割り当ててしまうことがある
              （見比べるで「AI案を採用」を選んだ結果、別の人が残している計算案と衝突するケース）。
              配信の唯一の入口である /api/dispatch は宛先ポストの重複を検証しないため、
              ここで検知してブロックする（気づかず2人を同じポストへ配信する事故を防ぐ） */}
          {duplicatePostCodes.length > 0 && (
            <div
              style={{
                border: `1px solid ${DAY.danger}`,
                background: "#FCE8ED",
                borderRadius: 10,
                padding: "8px 10px",
                fontSize: 13,
                color: DAY.danger,
                display: "grid",
                gap: 4,
              }}
            >
              <div style={{ fontWeight: 700 }}>配置が重複しています（配信できません）</div>
              {duplicatePostCodes.map(([code, names]) => (
                <div key={code}>
                  {code} に{names.length}名: {names.join("・")} — 「見比べる」でどちらか一方に選び直してください
                </div>
              ))}
            </div>
          )}

          {/* ── AIの状況 ── */}
          <div style={{ display: "grid", gap: 8 }}>
            {aiStatus === "loading" && (
              <div style={{ fontSize: 13, color: DAY.textDim }}>AIの案を計算中…（最大15秒待ちます。計算の案はそのまま使えます）</div>
            )}
            {aiStatus === "error" && (
              <div style={{ fontSize: 13, color: DAY.textDim }}>{aiError}</div>
            )}
            {aiStatus === "ok" && aiResult && (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: DAY.text }}>
                    {diffRows.length > 0
                      ? `AIの案ができました（${diffRows.length}件違います）`
                      : "AIの案ができました（計算案と一致しました）"}
                  </span>
                  {diffRows.length > 0 && (
                    <button
                      onClick={() => setShowCompare((v) => !v)}
                      style={{
                        minHeight: 44,
                        padding: "0 14px",
                        borderRadius: 9,
                        border: `1px solid ${DAY.line}`,
                        background: DAY.page,
                        color: DAY.text,
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {showCompare ? "閉じる" : "見比べる"}
                    </button>
                  )}
                </div>

                {/* note/rejected/warnings は黙って隠さない（APIが返した分は必ず出す）。
                    noteはAIが「手薄になる場所」を正直に書く欄なので、差分の有無に関わらず出す */}
                {aiResult.note && <div style={{ fontSize: 13, color: DAY.textDim }}>{aiResult.note}</div>}
                <div style={{ fontSize: 13, color: DAY.textDim }}>
                  AIの提案のうち棄却: <span className="cw-mono">{aiResult.rejected}</span>件
                </div>
                {aiResult.warnings.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#B45309" }}>
                    {aiResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}

                {showCompare && (
                  <div style={{ display: "grid", gap: 8 }}>
                    {diffRows.map((row) => {
                      const role = (row.calc ?? row.ai)!.role;
                      const selected = overrides.get(row.name) ?? "calc";
                      return (
                        <div
                          key={row.name}
                          style={{
                            border: "1px solid #FB7A1E",
                            background: "#FFF3E4",
                            borderRadius: 10,
                            padding: 10,
                            display: "grid",
                            gap: 6,
                          }}
                        >
                          <div style={{ fontSize: 15, fontWeight: 700, color: DAY.text }}>
                            {row.name}（{ROLE_LABEL[role]}）
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button
                              onClick={() => setOverride(row.name, "calc")}
                              style={{
                                minHeight: 44,
                                padding: "0 12px",
                                borderRadius: 9,
                                border: selected === "calc" ? `2px solid ${DAY.text}` : `1px solid ${DAY.line}`,
                                background: "#FFF",
                                color: DAY.text,
                                fontSize: 13,
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              計算案のまま{row.calc ? `: ${row.calc.toPostCode}（${row.calc.toZoneName}）` : "（配置しない）"}
                            </button>
                            <button
                              onClick={() => setOverride(row.name, "ai")}
                              style={{
                                minHeight: 44,
                                padding: "0 12px",
                                borderRadius: 9,
                                border: selected === "ai" ? "2px solid #FB7A1E" : `1px solid ${DAY.line}`,
                                background: "#FFF",
                                color: DAY.text,
                                fontSize: 13,
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              AI案を採用{row.ai ? `: ${row.ai.toPostCode}（${row.ai.toZoneName}）` : "（配置しない）"}
                            </button>
                          </div>
                          {selected === "ai" && row.ai?.reason && (
                            <div style={{ fontSize: 13, color: DAY.textDim }}>理由: {row.ai.reason}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── 配置案の一覧（計算案がベース。見比べるで選んだ分だけAIに置き換わる） ── */}
          <div style={{ display: "grid", gap: 6 }}>
            {finalAssignments.map((a) => (
              <div
                key={a.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 44,
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: `1px solid ${DAY.line}`,
                  background: DAY.page,
                  flexWrap: "wrap",
                }}
              >
                <SourceTag kind={a.source} tone="day" />
                <span style={{ fontSize: 15, fontWeight: 700, color: DAY.text }}>
                  {a.name} <span style={{ fontSize: 13, fontWeight: 400, color: DAY.textFaint }}>{ROLE_LABEL[a.role]}</span>
                </span>
                <span style={{ fontSize: 13, color: DAY.textFaint }}>
                  {postCodeLabel(a.fromCode)} → {a.toPostCode}（{a.toZoneName}）
                </span>
                {a.reason && <span style={{ fontSize: 13, color: DAY.textDim, flex: "1 1 100%" }}>{a.reason}</span>}
              </div>
            ))}
          </div>

          {/* ── 割り当てなかった分（黙って落とさない） ── */}
          {(calcPlan.unassigned.length > 0 || calcPlan.leftoverPosts.length > 0) && (
            <div style={{ display: "grid", gap: 6, fontSize: 13, color: DAY.textDim }}>
              <div style={{ fontWeight: 700, color: DAY.text }}>割り当てなかった分</div>
              <div>
                空席{vacantCount}件は名簿{candidateCount}名より少ないのが通常です（現在の計画＝チケット数に応じて空席の数が決まるため）。
                全員分の配置案が出ないのは正常です。
              </div>
              {calcPlan.unassigned.length > 0 && (
                <div>
                  未配置のまま（{calcPlan.unassigned.length}名）: {calcPlan.unassigned.map((c) => c.name).join("、")}
                </div>
              )}
              {calcPlan.leftoverPosts.length > 0 && (
                <div>
                  余った空席（{calcPlan.leftoverPosts.length}件）: {calcPlan.leftoverPosts.map((p) => p.code).join("、")}
                </div>
              )}
            </div>
          )}

          {/* ── 配信の進捗・結果 ── */}
          {dispatchProgress && (
            <div style={{ fontSize: 13, color: DAY.textDim }}>
              {dispatchBusy
                ? `${dispatchProgress.done}/${dispatchProgress.total} 配信中…`
                : /* 再送後は dispatchStatus が全実行分の累積になるため、分母もdispatchStatus.sizeに揃える
                     （直前バッチのtotalだけを分母にすると再送後に「9/3件成功」のような矛盾表示になる） */
                  `配信完了: ${dispatchOkCount}/${dispatchStatus.size}件成功`}
            </div>
          )}
          {dispatchDone && failedAssignments.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: DAY.danger }}>
                {failedAssignments.map((a) => (
                  <li key={a.name}>
                    {a.name}: {dispatchStatus.get(a.name)?.error ?? "失敗"}
                  </li>
                ))}
              </ul>
              <button
                onClick={handleResend}
                disabled={dispatchBusy}
                style={{
                  justifySelf: "start",
                  minHeight: 44,
                  padding: "0 16px",
                  borderRadius: 9,
                  border: `1px solid ${DAY.danger}`,
                  background: "#FCE8ED",
                  color: DAY.danger,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: dispatchBusy ? "wait" : "pointer",
                }}
              >
                失敗した{failedAssignments.length}件を再送
              </button>
            </div>
          )}
        </>
      )}

      <div style={{ fontSize: 11, color: DAY.textFaint }}>配置案は現在の計画（チケット数）に基づきます</div>

      {/* ── 一斉配信の最終確認モーダル（配信の唯一の入口 = /api/dispatch） ── */}
      {confirmOpen && (
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="一斉配信の最終確認"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(11,17,31,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: 14,
              padding: 20,
              maxWidth: 480,
              width: "100%",
              maxHeight: "80vh",
              display: "grid",
              gap: 12,
              gridTemplateRows: "auto 1fr auto",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: DAY.text }}>
              一斉配信の最終確認（{confirmItems.length}件）
            </h3>
            <div style={{ overflowY: "auto", display: "grid", gap: 6, borderTop: `1px solid ${DAY.line}`, borderBottom: `1px solid ${DAY.line}`, padding: "8px 0" }}>
              {confirmItems.map((a) => (
                <div key={a.name} style={{ fontSize: 13, color: DAY.text, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <b>{a.name}</b>
                  <span style={{ color: DAY.textFaint }}>
                    {postCodeLabel(a.fromCode)} → {a.toPostCode}（{a.toZoneName}）
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleConfirmDispatch}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 10,
                  border: "none",
                  background: DAY.text,
                  color: "#FFF",
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                配信する
              </button>
              <button
                onClick={closeConfirm}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 10,
                  border: `1px solid ${DAY.line}`,
                  background: "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                やめる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
