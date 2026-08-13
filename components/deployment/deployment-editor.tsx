"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { useScenario } from "@/lib/ui/scenario-context";
import { dayPlan } from "@/lib/forecast/model";
import { VENUE, zonesFor } from "@/lib/forecast/venue";
import { postsFor, ROLE_LABEL, type Post } from "@/lib/ops/staffing";
import { ROSTER, rosterByName } from "@/lib/data/roster";
import { buildAssignmentContext, planInitialAssignment } from "@/lib/ops/assign";
import {
  newDraftFromAssignments,
  movePlacement,
  unassignPlacement,
  vacantPostsOf,
  unassignedMembers,
  type DeploymentPlan,
  type Placement,
} from "@/lib/ops/deployment";
import VenueMap, { type StaffMark } from "../venue-map";
import { useDragToMap, type DropTarget } from "@/lib/ui/use-drag-to-map";
import PlacementTable from "./placement-table";
import type { Dispatch, Staff } from "@/lib/ops/store";

/**
 * 人員配置エディタ（計画モード・「人員配置」タブ 2026-08-14 新設）。
 *
 * この製品の中核機能: 会場の中に「誰をどこへ配置するか」をチェスの駒のように置いていき、
 * 仮組み → 微調整 → 人間の承認で確定 → 全員へ通知、という一連の流れをこの1画面に閉じる。
 *
 * 状態機械: `none`（計画なし）→ `draft`（編集中）→ `confirmed`（確定済み）。
 * 表示の決定則は「draftが存在すればdraft編集画面を最優先」（GETは draft/confirmed を
 * 独立に返すため両方non-nullがあり得る。draftが有ればそちらを操作対象にする、という
 * このコンポーネントのUX判断。confirmed情報は補足として draft 編集画面にも出す）。
 *
 * 土台（`lib/ops/deployment.ts`・`lib/ops/assign.ts`・`app/api/deployment-plan`・
 * `lib/ui/use-drag-to-map.ts`）は一切再実装しない。呼ぶだけ。
 * ただし「未割当メンバーを空席へ新規に割り当てる」合成だけはこのファイルに書く
 * （`movePlacement`は既存placementの移動/swapしか扱わず、新規追加は土台に無い）。
 */

type NotifyState = { state: "sending" | "ok" | "failed"; error?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 未割当メンバーを空席へ割り当てる／既存配置を動かす／未割当に戻す、を1本化した合成関数。
 * `movePlacement`/`unassignPlacement`（既存配置が対象）で扱えないケース（新規割り当て）だけ
 * ここで直接 `Placement` を組み立てる。plan.posts に無いコードは必ず拒否する
 * （孤児化根絶の契約を、この新規経路でも守る）。
 */
function applyMove(
  plan: DeploymentPlan,
  name: string,
  toPostCode: string
): { plan: DeploymentPlan; error?: string } {
  const existing = plan.placements.find((p) => p.name === name);

  if (toPostCode === "") {
    if (!existing) return { plan };
    return { plan: unassignPlacement(plan, existing.memberId) };
  }

  if (existing) {
    const result = movePlacement(plan, existing.memberId, toPostCode);
    if (!result.ok) {
      if (result.reason === "same-post") return { plan };
      return { plan, error: "その移動は行えませんでした（存在しないポストか、名簿に無いメンバーです）" };
    }
    return { plan: result.plan };
  }

  const member = rosterByName(name);
  if (!member) return { plan, error: `名簿に無い名前です: ${name}` };
  const targetPost = plan.posts.find((p) => p.code === toPostCode);
  if (!targetPost) return { plan, error: `存在しないポストです: ${toPostCode}` };

  const occupant = plan.placements.find((p) => p.postCode === toPostCode);
  const newPlacement: Placement = {
    memberId: member.id,
    name: member.name,
    role: member.role,
    postCode: targetPost.code,
    zoneId: targetPost.zoneId,
    fromHour: VENUE.open,
    toHour: VENUE.close,
  };
  const nextPlacements = occupant
    ? [...plan.placements.filter((p) => p.memberId !== occupant.memberId), newPlacement]
    : [...plan.placements, newPlacement];
  return { plan: { ...plan, placements: nextPlacements } };
}

/** DeploymentPlan（凍結済み posts + placements）から VenueMap 用のマークを組み立てる */
function buildDeployMarks(plan: DeploymentPlan): { marks: StaffMark[]; names: (string | null)[]; dimmedIdx: Set<number> } {
  const byPostCode = new Map(plan.placements.map((p) => [p.postCode, p]));
  const marks: StaffMark[] = [];
  const names: (string | null)[] = [];
  const dimmedIdx = new Set<number>();
  plan.posts.forEach((post, i) => {
    const placement = byPostCode.get(post.code);
    if (placement) {
      marks.push({ at: post.at, role: placement.role, label: post.code, glyph: placement.name.charAt(0), zoneId: post.zoneId });
      names.push(placement.name);
    } else {
      dimmedIdx.add(i);
      marks.push({ at: post.at, role: post.role, label: post.code, zoneId: post.zoneId });
      names.push(null);
    }
  });
  return { marks, names, dimmedIdx };
}

const FOCUSABLE_SELECTOR = 'a[href], button, select, input, textarea, [tabindex]:not([tabindex="-1"])';
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => !el.hasAttribute("disabled"));
}

const SAVE_DEBOUNCE_MS = 800;

export default function DeploymentEditor() {
  const { scenario } = useScenario();
  const [hour, setHour] = useState(15);

  const dayPlanValue = useMemo(() => dayPlan(scenario), [scenario]);
  const scenarioPosts = useMemo(() => postsFor(dayPlanValue), [dayPlanValue]);

  // ── 計画の読み込み ──────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DeploymentPlan | null>(null);
  const [confirmed, setConfirmed] = useState<DeploymentPlan | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const draftRef = useRef<DeploymentPlan | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/deployment-plan");
        const data = await res.json();
        if (!alive) return;
        setDraft(data?.draft ?? null);
        setConfirmed(data?.confirmed ?? null);
      } catch {
        if (alive) setError("計画の読み込みに失敗しました");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ── 「配置案をつくる」に使う当日データ（候補・空席の把握のみ。都度取得） ──────
  const [candidateCount, setCandidateCount] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchOpsData = useCallback(async (): Promise<{ staffList: Staff[]; dispatches: Dispatch[] }> => {
    const [staffRes, dispatchRes] = await Promise.all([
      fetch("/api/staff").then((r) => r.json()),
      fetch("/api/dispatch").then((r) => r.json()),
    ]);
    return {
      staffList: Array.isArray(staffRes?.staff) ? staffRes.staff : [],
      dispatches: Array.isArray(dispatchRes?.dispatches) ? dispatchRes.dispatches : [],
    };
  }, []);

  // 初回に候補数を出しておく（draft/confirmedどちらも無いときの「配置案をつくる」表示用）
  useEffect(() => {
    if (draft || confirmed || loading) return;
    let alive = true;
    (async () => {
      try {
        const { staffList, dispatches } = await fetchOpsData();
        if (!alive) return;
        const ctx = buildAssignmentContext(ROSTER, scenarioPosts, staffList, dispatches, Date.now());
        setCandidateCount(ctx.candidates.length);
      } catch {
        /* 候補数の表示だけなので握りつぶしてよい（ボタン自体は押せる） */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, confirmed, loading, scenarioPosts]);

  const handleCreateDraft = useCallback(
    async (basePosts: Post[]) => {
      setCreating(true);
      setError("");
      try {
        const { staffList, dispatches } = await fetchOpsData();
        const ctx = buildAssignmentContext(ROSTER, basePosts, staffList, dispatches, Date.now());
        const { assignments } = planInitialAssignment(ctx);
        const seed = newDraftFromAssignments(
          assignments,
          basePosts,
          { tickets: scenario.tickets, weather: String(scenario.weather), temp: scenario.temp },
          Date.now()
        );
        const res = await fetch("/api/deployment-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ posts: seed.posts, placements: seed.placements, scenarioSnapshot: seed.scenarioSnapshot }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(isRecord(data) && typeof data.error === "string" ? data.error : "配置案の作成に失敗しました");
          return;
        }
        setDraft(data.plan);
      } catch {
        setError("配置案の作成に失敗しました（通信エラー）");
      } finally {
        setCreating(false);
      }
    },
    [fetchOpsData, scenario]
  );

  // ── デバウンス保存（PATCH）── 1本の in-flight を保証し、保存中の変更は取りこぼさない
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveRef = useRef(false);
  const dirtyRef = useRef(false);

  const doSave = useCallback((): Promise<void> => {
    const p = (async () => {
      const current = draftRef.current;
      if (!current) return;
      try {
        const res = await fetch("/api/deployment-plan", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: current.id,
            version: current.version,
            placements: current.placements.map((pl) => ({
              name: pl.name,
              postCode: pl.postCode,
              fromHour: pl.fromHour,
              toHour: pl.toHour,
            })),
          }),
        });
        const data = await res.json();
        if (res.status === 409 && isRecord(data) && data.plan) {
          // 黙って捨てない・黙って上書きしない: 非ブロッキングの通知を出し、最新版で丸ごと再描画する
          setNotice("他の端末が計画を更新しました。最新版を読み込みます");
          setDraft(data.plan as DeploymentPlan);
          dirtyRef.current = false;
          return;
        }
        if (!res.ok) {
          setError(isRecord(data) && typeof data.error === "string" ? data.error : "保存に失敗しました");
          return;
        }
        // 成功時は version/id だけを取り込み、placements はローカルを正本のまま保つ
        // （保存中に別のドラッグが起きていた場合、レスポンスの古いplacementsで上書きしない）
        const savedVersion = isRecord(data.plan) && typeof data.plan.version === "number" ? data.plan.version : undefined;
        if (savedVersion !== undefined) {
          setDraft((prev) => (prev && prev.id === current.id ? { ...prev, version: savedVersion } : prev));
        }
        dirtyRef.current = false;
      } catch {
        setError("保存に失敗しました（通信エラー）。次の変更で再試行します");
      }
    })();
    savePromiseRef.current = p.finally(() => {
      savePromiseRef.current = null;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void doSave();
      }
    });
    return savePromiseRef.current;
  }, []);

  const triggerSave = useCallback((): Promise<void> => {
    if (savePromiseRef.current) {
      pendingSaveRef.current = true;
      return savePromiseRef.current;
    }
    return doSave();
  }, [doSave]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void triggerSave();
    }, SAVE_DEBOUNCE_MS);
  }, [triggerSave]);

  const flushPendingSave = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyRef.current || savePromiseRef.current) {
      await triggerSave();
    }
  }, [triggerSave]);

  // アンマウント時にタイマーだけ止める（保存自体は継続させてよい）
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // ── 微調整（移動・未割当に戻す・新規割り当て） ────────────────────────
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  const handleMove = useCallback(
    (name: string, toPostCode: string) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const { plan: next, error: err } = applyMove(prev, name, toPostCode);
        if (err) {
          setError(err);
          return prev;
        }
        if (next === prev) return prev;
        draftRef.current = next;
        scheduleSave();
        return next;
      });
    },
    [scheduleSave]
  );

  const handleSelect = useCallback((name: string) => {
    setSelectedName((prev) => {
      const next = prev === name ? null : name;
      if (next) requestAnimationFrame(() => mapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      return next;
    });
  }, []);

  // ── D&D（会場図の駒 ⇄ 表の行、双方向） ──────────────────────────────
  const handleDrop = useCallback(
    (name: string, target: DropTarget) => {
      const plan = draftRef.current;
      if (!plan) return;
      let toPostCode = target.postCode;
      if (!toPostCode) {
        const firstVacant = vacantPostsOf(plan).find((p) => p.zoneId === target.zoneId);
        if (!firstVacant) {
          setNotice("そのゾーンには空席がありません");
          return;
        }
        toPostCode = firstVacant.code;
      }
      handleMove(name, toPostCode);
    },
    [handleMove]
  );

  const drag = useDragToMap({ onDrop: handleDrop, disabled: !draft });

  const marksModel = useMemo(() => (draft ? buildDeployMarks(draft) : null), [draft]);

  const handleStaffPointerDown = useCallback(
    (index: number, e: React.PointerEvent) => {
      const name = marksModel?.names[index];
      if (!name) return;
      drag.markHandlers(name).onPointerDown(e);
    },
    [drag, marksModel]
  );

  const draggingIndex = useMemo(() => {
    if (!drag.draggingName || !marksModel) return null;
    const idx = marksModel.names.findIndex((n) => n === drag.draggingName);
    return idx >= 0 ? idx : null;
  }, [drag.draggingName, marksModel]);

  const selectedStaffIndex = useMemo(() => {
    if (!selectedName || !marksModel) return null;
    const idx = marksModel.names.findIndex((n) => n === selectedName);
    return idx >= 0 ? idx : null;
  }, [selectedName, marksModel]);

  useEffect(() => {
    if (!drag.draggingName) return;
    mapRef.current?.scrollIntoView({ block: "nearest" });
  }, [drag.draggingName]);

  // ── 確定 ────────────────────────────────────────────────────────
  const [confirmBusy, setConfirmBusy] = useState(false);

  const handleConfirm = useCallback(async () => {
    if (!draft || confirmBusy) return;
    setConfirmBusy(true);
    setError("");
    try {
      // 確定PATCHの前に、保留中の変更を必ず反映しておく（版がずれたまま確定を叩かない）
      await flushPendingSave();
      const current = draftRef.current;
      if (!current) return;
      const res = await fetch("/api/deployment-plan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: current.id, version: current.version, status: "confirmed" }),
      });
      const data = await res.json();
      if (res.status === 409 && isRecord(data) && data.plan) {
        setNotice("他の端末が計画を更新しました。最新版を読み込みます。もう一度お試しください");
        setDraft(data.plan as DeploymentPlan);
        return;
      }
      if (!res.ok) {
        setError(isRecord(data) && typeof data.error === "string" ? data.error : "確定に失敗しました");
        return;
      }
      setConfirmed(data.plan);
      setDraft(null);
      setSelectedName(null);
      setNotice("配置を確定しました");
    } catch {
      setError("確定に失敗しました（通信エラー）");
    } finally {
      setConfirmBusy(false);
    }
  }, [draft, confirmBusy, flushPendingSave]);

  // ── 確定後の通知（/api/dispatch を1件ずつ逐次。initial-plan-panel.tsx の runDispatch と同じ方式） ──
  const [notifyStatus, setNotifyStatus] = useState<Map<string, NotifyState>>(new Map());
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyProgress, setNotifyProgress] = useState<{ done: number; total: number } | null>(null);
  const [notifyConfirmOpen, setNotifyConfirmOpen] = useState(false);
  const notifyModalRef = useRef<HTMLDivElement>(null);

  const runNotify = useCallback(async (items: Placement[]) => {
    if (items.length === 0) return;
    setNotifyBusy(true);
    setNotifyProgress({ done: 0, total: items.length });
    const next = new Map(notifyStatus);
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      next.set(p.memberId, { state: "sending" });
      setNotifyStatus(new Map(next));
      try {
        const res = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            staffName: p.name,
            fromCode: "",
            toZoneId: p.zoneId,
            toPostCode: p.postCode,
            action: "配置についてください",
            urgency: "soon",
            reason: `確定した配置計画: ${p.postCode}`,
          }),
        });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok) {
          const msg = isRecord(data) && typeof data.error === "string" ? data.error : `エラー（${res.status}）`;
          next.set(p.memberId, { state: "failed", error: msg });
        } else {
          next.set(p.memberId, { state: "ok" });
        }
      } catch {
        next.set(p.memberId, { state: "failed", error: "通信エラー" });
      }
      setNotifyStatus(new Map(next));
      setNotifyProgress({ done: i + 1, total: items.length });
    }
    setNotifyBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingNotify = useMemo(
    () => (confirmed ? confirmed.placements.filter((p) => notifyStatus.get(p.memberId)?.state !== "ok") : []),
    [confirmed, notifyStatus]
  );
  const failedNotify = useMemo(
    () => (confirmed ? confirmed.placements.filter((p) => notifyStatus.get(p.memberId)?.state === "failed") : []),
    [confirmed, notifyStatus]
  );

  const openNotifyConfirm = useCallback(() => {
    if (pendingNotify.length === 0 || notifyBusy) return;
    setNotifyConfirmOpen(true);
  }, [pendingNotify, notifyBusy]);

  useEffect(() => {
    if (!notifyConfirmOpen) return;
    const prev = document.activeElement;
    focusablesIn(notifyModalRef.current)[0]?.focus();
    return () => {
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [notifyConfirmOpen]);

  useEffect(() => {
    if (!notifyConfirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNotifyConfirmOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusablesIn(notifyModalRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const atEdge = e.shiftKey ? active === first : active === last;
      if (atEdge || !(notifyModalRef.current?.contains(active) ?? false)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notifyConfirmOpen]);

  // ── 表示分岐 ────────────────────────────────────────────────────
  const vacantCount = draft ? vacantPostsOf(draft).length : 0;
  const unassignedCount = draft ? unassignedMembers(ROSTER, draft).length : 0;

  if (loading) {
    return (
      <div style={{ background: DAY.surface, border: `1px solid ${DAY.line}`, borderRadius: 12, padding: 20, fontSize: 13, color: DAY.textDim }}>
        読み込み中…
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: DAY.textDim, lineHeight: 1.8 }}>
        会場の中に人員配置を計画する — 仮組み → 会場図か下の表で微調整 → 「この配置で確定する」で承認 →
        確定後に全員へ通知。ドラッグ&ドロップはチェスの駒を動かす感覚で、確認ダイアログは出ません
        （取り消したいときは元の位置へ戻すか、確定前なら下書きごと作り直せます）。
      </p>

      {notice && (
        <div role="status" style={{ background: "#EAF7F1", border: "1px solid #0F6E56", borderRadius: 9, padding: "8px 10px", fontSize: 13, color: "#0F6E56" }}>
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ background: "#FCE8ED", border: `1px solid ${DAY.danger}`, borderRadius: 9, padding: "8px 10px", fontSize: 13, color: DAY.danger, display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError("")} style={{ border: "none", background: "transparent", color: DAY.danger, fontWeight: 700, cursor: "pointer" }}>
            閉じる
          </button>
        </div>
      )}

      {/* ── none: 計画なし ── */}
      {!draft && !confirmed && (
        <div style={{ background: DAY.surface, border: `1px solid ${DAY.line}`, borderRadius: 12, padding: "16px 18px", display: "grid", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: DAY.text }}>まだ配置計画がありません</div>
          <div style={{ fontSize: 13, color: DAY.textDim }}>
            名簿{ROSTER.length}名を現在の計画（チケット数・天候）の配置ポストへ機械的に割り当て、
            仮の配置案として作ります（決定的計算・LLM不使用）。作った後で会場図・表から微調整できます。
            {candidateCount !== null && <>（未配置候補 {candidateCount}名・空席 {scenarioPosts.length}件）</>}
          </div>
          <button
            onClick={() => void handleCreateDraft(scenarioPosts)}
            disabled={creating}
            style={{
              justifySelf: "start",
              minHeight: 44,
              padding: "0 18px",
              borderRadius: 9,
              border: "none",
              background: creating ? "#93A3C0" : DAY.text,
              color: "#FFF",
              fontSize: 15,
              fontWeight: 700,
              cursor: creating ? "wait" : "pointer",
            }}
          >
            {creating ? "作成中…" : "配置案をつくる"}
          </button>
        </div>
      )}

      {/* ── confirmed（draftなし）: 確定済み計画の表示と通知 ── */}
      {!draft && confirmed && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ background: DAY.surface, border: `1px solid ${DAY.line}`, borderRadius: 12, padding: "14px 16px", display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 19, fontWeight: 700, color: DAY.text }}>確定済みの配置計画</span>
              <span style={{ fontSize: 13, color: DAY.textFaint }}>
                {confirmed.placements.length}名配置・v{confirmed.version}
              </span>
              <button
                onClick={openNotifyConfirm}
                disabled={pendingNotify.length === 0 || notifyBusy}
                style={{
                  marginLeft: "auto",
                  minHeight: 44,
                  padding: "0 16px",
                  borderRadius: 9,
                  border: "none",
                  background: pendingNotify.length === 0 || notifyBusy ? "#93A3C0" : DAY.text,
                  color: "#FFF",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: pendingNotify.length === 0 || notifyBusy ? "not-allowed" : "pointer",
                }}
              >
                確定内容を全員に通知（{pendingNotify.length}件）
              </button>
            </div>

            {notifyProgress && (
              <div style={{ fontSize: 13, color: DAY.textDim }}>
                {notifyBusy
                  ? `${notifyProgress.done}/${notifyProgress.total} 配信中…`
                  : `配信完了: ${[...notifyStatus.values()].filter((s) => s.state === "ok").length}/${notifyStatus.size}件成功`}
              </div>
            )}
            {!notifyBusy && failedNotify.length > 0 && (
              <div style={{ display: "grid", gap: 6 }}>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: DAY.danger }}>
                  {failedNotify.map((p) => (
                    <li key={p.memberId}>
                      {p.name}: {notifyStatus.get(p.memberId)?.error ?? "失敗"}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => void runNotify(failedNotify)}
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
                    cursor: "pointer",
                  }}
                >
                  失敗した{failedNotify.length}件を再送
                </button>
              </div>
            )}

            <button
              onClick={() => void handleCreateDraft(confirmed.posts)}
              disabled={creating}
              style={{
                justifySelf: "start",
                minHeight: 44,
                padding: "0 16px",
                borderRadius: 9,
                border: `1px solid ${DAY.line}`,
                background: DAY.page,
                color: DAY.text,
                fontSize: 13,
                fontWeight: 700,
                cursor: creating ? "wait" : "pointer",
              }}
            >
              {creating ? "作成中…" : "この計画をもとに新しい下書きを作る"}
            </button>
            <div style={{ fontSize: 11, color: DAY.textFaint }}>
              確定済みの計画はここでは編集できません（編集は新しい下書きに対してのみ行えます）。
            </div>
          </div>
        </div>
      )}

      {/* ── draft: 編集中 ── */}
      {draft && marksModel && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: DAY.text }}>配置を編集中（下書き）</span>
            <span style={{ fontSize: 13, color: DAY.textFaint }}>
              配置済み <span className="cw-mono">{draft.placements.length}</span>／空席{" "}
              <span className="cw-mono">{vacantCount}</span>／未割当{" "}
              <span className="cw-mono">{unassignedCount}</span>
            </span>
            <button
              onClick={() => void handleConfirm()}
              disabled={confirmBusy}
              style={{
                marginLeft: "auto",
                minHeight: 44,
                padding: "0 18px",
                borderRadius: 9,
                border: "none",
                background: confirmBusy ? "#93A3C0" : DAY.text,
                color: "#FFF",
                fontSize: 15,
                fontWeight: 700,
                cursor: confirmBusy ? "wait" : "pointer",
              }}
            >
              {confirmBusy ? "確定中…" : "この配置で確定する"}
            </button>
          </div>
          {confirmed && (
            <div style={{ fontSize: 11, color: DAY.textFaint }}>
              既に確定済みの計画（v{confirmed.version}）があります。この下書きを確定するとそちらが更新されます。
            </div>
          )}

          {/* 時刻コントロール（会場図の日照/影の表示用） */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: DAY.textDim }}>表示時刻</span>
            <input
              type="range"
              min={VENUE.open}
              max={VENUE.close}
              value={hour}
              onChange={(e) => setHour(+e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
              aria-label="表示時刻"
            />
            <span className="cw-mono" style={{ fontSize: 19, fontWeight: 700, width: 70 }}>
              {hour}:00
            </span>
          </div>

          {/* ── 会場図（フル幅・上部） ── */}
          <div ref={mapRef}>
            <VenueMap
              zones={zonesFor("in")}
              hour={hour}
              scenario={scenario}
              layer="crowd"
              staff={marksModel.marks}
              dimmedStaffIndices={marksModel.dimmedIdx}
              selectedStaffIndex={selectedStaffIndex}
              onStaffClick={(i) => {
                const name = marksModel.names[i];
                if (name) handleSelect(name);
              }}
              staffLabelMode="focus"
              highlightZoneId={drag.overZoneId}
              staffHitRadius={22}
              onStaffPointerDown={handleStaffPointerDown}
              staffDraggingIndex={draggingIndex}
            />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, color: DAY.textFaint, marginTop: 8 }}>
              <span>細リング=ポスト（常時）</span>
              <span>塗り丸=配置済みの駒（ドラッグで移動・入れ替え可）</span>
              <span>駒をつかんで別の駒の上に離すと入れ替わります</span>
            </div>
          </div>

          {/* ── 下部の表（唯一のキーボード操作経路） ── */}
          <PlacementTable
            plan={draft}
            selectedName={selectedName}
            onSelect={handleSelect}
            onMove={handleMove}
            dragRowHandlers={drag.rowHandlers}
            draggingName={drag.draggingName}
          />

          {/* 追従チップ（use-drag-to-map.ts の作法どおり） */}
          {drag.draggingName && (
            <div
              ref={drag.chipRef}
              aria-hidden
              style={{ position: "fixed", left: 0, top: 0, pointerEvents: "none", zIndex: 2000, transform: "translate3d(-9999px, -9999px, 0)", willChange: "transform" }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  transform: "translate(10px, 10px)",
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: DAY.text,
                  color: "#FFFFFF",
                  fontSize: 13,
                  fontWeight: 700,
                  boxShadow: "0 6px 20px rgba(11,17,31,0.35)",
                  whiteSpace: "nowrap",
                }}
              >
                {drag.draggingName}
                <span style={{ opacity: 0.8, fontWeight: 400 }}>を移動先へ</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── 通知の最終確認モーダル（配信の唯一の入口 = /api/dispatch） ── */}
      {notifyConfirmOpen && confirmed && (
        <div
          ref={notifyModalRef}
          role="dialog"
          aria-modal="true"
          aria-label="確定内容の通知"
          style={{ position: "fixed", inset: 0, background: "rgba(11,17,31,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}
        >
          <div style={{ background: "#FFFFFF", borderRadius: 14, padding: 20, maxWidth: 480, width: "100%", maxHeight: "80vh", display: "grid", gap: 12, gridTemplateRows: "auto 1fr auto" }}>
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: DAY.text }}>
              確定内容を通知します（{pendingNotify.length}件）
            </h3>
            <div style={{ overflowY: "auto", display: "grid", gap: 6, borderTop: `1px solid ${DAY.line}`, borderBottom: `1px solid ${DAY.line}`, padding: "8px 0" }}>
              {pendingNotify.map((p) => (
                <div key={p.memberId} style={{ fontSize: 13, color: DAY.text, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <b>{p.name}</b>
                  <span style={{ color: DAY.textFaint }}>
                    {p.postCode}（{ROLE_LABEL[p.role]}）
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setNotifyConfirmOpen(false);
                  void runNotify(pendingNotify);
                }}
                style={{ flex: 1, minHeight: 48, borderRadius: 10, border: "none", background: DAY.text, color: "#FFF", fontWeight: 700, fontSize: 15, cursor: "pointer" }}
              >
                通知する
              </button>
              <button
                onClick={() => setNotifyConfirmOpen(false)}
                style={{ flex: 1, minHeight: 48, borderRadius: 10, border: `1px solid ${DAY.line}`, background: "#FFF", color: DAY.text, fontWeight: 700, fontSize: 15, cursor: "pointer" }}
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
