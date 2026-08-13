"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { useScenario } from "@/lib/ui/scenario-context";
import { dayPlan } from "@/lib/forecast/model";
import { VENUE, zonesFor } from "@/lib/forecast/venue";
import { postsFor, ROLE_LABEL, zoneById, type PostRole } from "@/lib/ops/staffing";
import { ROSTER, rosterByName, type RosterGroup, type RosterMember } from "@/lib/data/roster";
import {
  buildBoardMarks,
  isAssignedTo,
  latestDispatchFor,
  memberBadge,
  postCodeLabel,
  type MemberStatus,
} from "@/lib/ops/board";
import VenueMap from "./venue-map";
import type { Dispatch, Staff } from "@/lib/ops/store";
import StoreStatus from "./store-status";
import SyncBadge from "./sync-badge";
import { useSyncStatus } from "@/lib/ui/use-polling";

/**
 * 配置ボード（当日モード「配置」タブ）— 名簿（リスト）と会場図（マップ）の二重体制。
 *
 * 2026-08-13 新設。従来の調整コンソール配置ボードは「いま入場している人」しか
 * 地図に出せなかった（zoneId が無い＝presence登録のみのメンバーは描けない）。
 * ここでは `lib/data/roster.ts` の仮名簿23名を軸に、未接続・配置待ちの状態も
 * 名簿の行として常に見える形にし、指示は名簿から出せるようにする
 * （現場は「まだ来ていない人に先に指示を出す」運用が普通にある）。
 *
 * 選択状態は「名前」で一元管理し、リスト行とマップの丸を相互に同期させる
 * （`lib/ops/board.ts` の buildBoardMarks が両者の対応表 entryStaff を返す）。
 * 配信は adjust-console.tsx と同じ /api/dispatch 一本（人間確認モーダルが唯一の入口）。
 */

const POLL_MS = 5000;

const ROLE_COLOR: Record<PostRole, string> = {
  water: "#38BDF8",
  guide: "#FDE047",
  aid: "#22C55E",
  reception: "#C4B5FD",
};

const STATUS_STYLE: Record<MemberStatus, { bg: string; border: string; text: string; label: string }> = {
  unregistered: { bg: "#F1F3F8", border: DAY.line, text: DAY.textDim, label: "未接続" },
  waiting: { bg: "#E6F2FE", border: "#38BDF8", text: "#0B5C8C", label: "配置待ち" },
  onpost: { bg: "#E9F8EF", border: "#22C55E", text: "#0F6E56", label: "着任" },
  moving: { bg: "#FFF3E4", border: "#FB7A1E", text: "#B45309", label: "移動中" },
  away: { bg: "#FCE8ED", border: DAY.danger, text: DAY.danger, label: "離脱" },
};

/** グループの表示順（ROSTER の並びは頭文字ユニークだが、グループ順は明示する） */
const GROUP_ORDER: RosterGroup[] = ["メイン", "フード", "サブ", "給水", "救護", "受付"];

/** 空状態ガイドで示す専用URLの範囲（名簿の先頭と末尾。ROSTER が増減しても文言が嘘にならないよう導出する） */
const ROSTER_FIRST = ROSTER[0];
const ROSTER_LAST = ROSTER[ROSTER.length - 1];

/** モーダル内でフォーカスを受け取れる要素（Tab循環の対象） */
const FOCUSABLE_SELECTOR = 'a[href], button, select, input, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * モーダル内のフォーカス可能要素。disabled は除く。
 * 配信中は下段2ボタンが disabled になるため、Tabのたびに取り直すこと（固定配列にしない）。
 */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled")
  );
}

/** ROSTER をグループ順に束ねる。ROSTER は静的なので一度だけ計算する */
const ROSTER_BY_GROUP: [RosterGroup, RosterMember[]][] = (() => {
  const map = new Map<RosterGroup, RosterMember[]>();
  for (const m of ROSTER) {
    const arr = map.get(m.group) ?? [];
    arr.push(m);
    map.set(m.group, arr);
  }
  const ordered: [RosterGroup, RosterMember[]][] = [];
  for (const g of GROUP_ORDER) {
    const arr = map.get(g);
    if (arr && arr.length > 0) ordered.push([g, arr]);
  }
  return ordered;
})();

type RowInfo = { id: string; name: string; role: PostRole };

export default function StaffBoard() {
  const { scenario } = useScenario();
  const [hour, setHour] = useState(15);

  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);

  const [selName, setSelName] = useState<string | null>(null);
  const [moveTargetZoneId, setMoveTargetZoneId] = useState<string | null>(null);
  const [selectedPostCode, setSelectedPostCode] = useState("");
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState<"now" | "soon">("soon");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 初回の取得が成功したか。未取得のうちは「誰も接続していません」と言い切らない（嘘の空状態を出さない） */
  const [loaded, setLoaded] = useState(false);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const mapRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const posts = useMemo(() => postsFor(plan), [plan]);

  // ── ポーリング（スタッフ・指示） ──
  const sync = useSyncStatus();
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch("/api/staff").then((r) => r.json()),
          fetch("/api/dispatch").then((r) => r.json()),
        ]);
        if (!alive) return;
        if (Array.isArray(r1.staff)) setStaffList(r1.staff);
        if (Array.isArray(r2.dispatches)) setDispatches(r2.dispatches);
        setLoaded(true);
        sync.markOk();
      } catch {
        if (alive) sync.markFail();
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const staffByName = useMemo(() => new Map(staffList.map((s) => [s.name, s])), [staffList]);
  const board = useMemo(() => buildBoardMarks(staffList, posts, dispatches), [staffList, posts, dispatches]);

  const counts = useMemo(() => {
    const c = { onpost: 0, moving: 0, waiting: 0, unregistered: 0 };
    const now = Date.now();
    for (const m of ROSTER) {
      const badge = memberBadge(staffByName.get(m.name), latestDispatchFor(m.name, dispatches), now);
      if (badge.status === "onpost") c.onpost++;
      else if (badge.status === "moving") c.moving++;
      else if (badge.status === "waiting") c.waiting++;
      else if (badge.status === "unregistered") c.unregistered++;
    }
    return c;
  }, [staffByName, dispatches]);

  const vacantCount = useMemo(
    () => posts.filter((p) => !staffList.some((s) => isAssignedTo(s.postCode, p.code))).length,
    [posts, staffList]
  );

  /** 名簿外の入場者（staffList にいるが ROSTER にいない名前） */
  const offRoster = useMemo(() => staffList.filter((s) => !rosterByName(s.name)), [staffList]);

  const unanswered = useMemo(
    () => dispatches.filter((d) => d.status === "sent" && Date.now() - d.createdAt > 10 * 60_000),
    [dispatches]
  );

  /**
   * 初回訪問のガイドを出す条件: 取得済み かつ 名簿全員が未接続 かつ 名簿外の入場者もいない。
   * 1人でも接続していれば出さない（毎回出ると邪魔になる）。
   */
  const showEmptyGuide = loaded && offRoster.length === 0 && counts.unregistered === ROSTER.length;

  const selStaff = selName ? staffByName.get(selName) : undefined;

  const selStaffIndex = useMemo(() => {
    if (!selName) return null;
    return board.entryStaff.findIndex((s) => s?.name === selName);
  }, [selName, board.entryStaff]);

  const registerRef = useCallback((name: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(name, el);
    else rowRefs.current.delete(name);
  }, []);

  const handleListSelect = useCallback((name: string) => {
    setSelName((prev) => {
      const next = prev === name ? null : name;
      if (next) {
        requestAnimationFrame(() => mapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      }
      return next;
    });
  }, []);

  const handleStaffClick = useCallback(
    (i: number) => {
      const s = board.entryStaff[i];
      if (!s) return;
      setSelName((prev) => {
        const next = prev === s.name ? null : s.name;
        if (next) {
          requestAnimationFrame(() => rowRefs.current.get(s.name)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
        }
        return next;
      });
    },
    [board.entryStaff]
  );

  const handleZoneClick = useCallback(
    (zoneId: string) => {
      if (!selName) return;
      const zonePosts = posts.filter((p) => p.zoneId === zoneId);
      const firstVacant = zonePosts.find((p) => !staffList.some((s) => isAssignedTo(s.postCode, p.code)));
      setMoveTargetZoneId(zoneId);
      setSelectedPostCode(firstVacant?.code ?? "");
      setReason("");
      setUrgency("soon");
      setError("");
    },
    [selName, posts, staffList]
  );

  const zonePosts = useMemo(
    () => (moveTargetZoneId ? posts.filter((p) => p.zoneId === moveTargetZoneId) : []),
    [moveTargetZoneId, posts]
  );
  const targetZoneName = moveTargetZoneId ? (zoneById(moveTargetZoneId)?.name ?? moveTargetZoneId) : "";

  function cancelMove() {
    if (busy) return;
    setMoveTargetZoneId(null);
    setError("");
  }

  const modalOpen = Boolean(selName && moveTargetZoneId);

  /**
   * フォーカスの出入り（2026-08-13 追加）。開いた瞬間に最初の操作要素（移動先ポストのselect）へ移し、
   * 閉じたら開く前の要素へ戻す。依存は modalOpen だけにする — busy を入れると
   * 配信中に cleanup→再実行が走ってフォーカスが飛ぶ。
   */
  useEffect(() => {
    if (!modalOpen) return;
    // 退避は focus() を移す前に取ること（順序が逆だとモーダル内の要素を「元の場所」として覚えてしまう）。
    // 地図のゾーンはSVG要素なので HTMLElement だけでは拾えない
    const prev = document.activeElement;
    focusablesIn(modalRef.current)[0]?.focus();
    return () => {
      if (prev instanceof HTMLElement || prev instanceof SVGElement) prev.focus();
    };
  }, [modalOpen]);

  // Escキーで閉じる／Tabをモーダル内で循環させる（キーボードのみの操作を塞がないため。2026-08-13 追加）
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelMove();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, busy]);

  async function submitDispatch() {
    if (!selName || !moveTargetZoneId || busy) return;
    setBusy(true);
    setError("");
    try {
      const trimmedReason = reason.trim();
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffName: selName,
          fromCode: selStaff?.postCode ?? "",
          toZoneId: moveTargetZoneId,
          ...(selectedPostCode ? { toPostCode: selectedPostCode } : {}),
          action: trimmedReason || "配置についてください",
          urgency,
          reason: trimmedReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(`配信できませんでした: ${data?.error ?? res.status}`);
        return;
      }
      setMoveTargetZoneId(null);
      setSelName(null);
      setNotice("配信しました");
    } catch {
      setError("配信できませんでした: 通信エラー");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: DAY.page, color: DAY.text, borderRadius: 16, border: `1px solid ${DAY.line}`, padding: 14, display: "grid", gap: 12 }}>
      <style>{`
        @media (max-width: 760px) {
          .cw-board { grid-template-columns: 1fr !important; }
          .cw-board-list { max-height: 40vh; overflow-y: auto; }
        }
      `}</style>

      {/* 見出し + 集計ピル */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>配置ボード — 仮名簿（デモデータ）</h2>
        <StoreStatus />
        <SyncBadge sync={sync} tone="day" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill label="着任" n={counts.onpost} color="#0F6E56" bg="#E9F8EF" />
          <Pill label="移動中" n={counts.moving} color="#B45309" bg="#FFF3E4" />
          <Pill label="配置待ち" n={counts.waiting} color="#0B5C8C" bg="#E6F2FE" />
          <Pill label="未接続" n={counts.unregistered} color={DAY.textDim} bg="#F1F3F8" />
          <Pill label="空席" n={vacantCount} color={DAY.danger} bg="#FCE8ED" />
        </div>
      </div>

      {/* 時刻コントロール */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: DAY.textDim }}>シミュレーション時刻</span>
        <input
          type="range"
          min={VENUE.open}
          max={VENUE.close}
          value={hour}
          onChange={(e) => setHour(+e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
          aria-label="時刻"
        />
        <span className="cw-mono" style={{ fontSize: 19, fontWeight: 700, width: 70 }}>{hour}:00</span>
      </div>

      {notice && (
        <div
          role="status"
          style={{ background: "#EAF7F1", border: "1px solid #0F6E56", borderRadius: 9, padding: "8px 10px", fontSize: 13, color: "#0F6E56" }}
        >
          {notice}
        </div>
      )}

      <div className="cw-board" style={{ display: "grid", gridTemplateColumns: "minmax(320px, 400px) 1fr", gap: 12 }}>
        {/* ── リスト ── */}
        <div className="cw-board-list" style={{ display: "grid", gap: 10, alignContent: "start" }}>
          {/* sticky選択バー */}
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 20,
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              padding: "6px 12px",
              borderRadius: 10,
              border: `1px solid ${DAY.line}`,
              background: selName ? DAY.text : DAY.surface,
              color: selName ? "#FFFFFF" : DAY.textDim,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {selName ? (
              <>
                <span>
                  {selName}（{postCodeLabel(selStaff?.postCode ?? "")}）を選択中 — 移動先のゾーンをタップ。もう一度タップで解除
                </span>
                <button
                  onClick={() => setSelName(null)}
                  style={{
                    marginLeft: "auto",
                    minHeight: 44,
                    minWidth: 44,
                    padding: "0 12px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.6)",
                    background: "transparent",
                    color: "#FFFFFF",
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  解除
                </button>
              </>
            ) : (
              <span>メンバーを選ぶ → 移動先のゾーンをタップ</span>
            )}
          </div>

          {showEmptyGuide && (
            <div
              style={{
                background: DAY.surface,
                border: `1px solid ${DAY.line}`,
                borderRadius: 12,
                padding: "12px 14px",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700 }}>まだ誰も接続していません</div>
              <div style={{ fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
                各スタッフに専用URLを配ると、接続状態がここに出ます。URLは{" "}
                <span className="cw-mono">/staff/{ROSTER_FIRST.id}</span>（{ROSTER_FIRST.name}）〜{" "}
                <span className="cw-mono">/staff/{ROSTER_LAST.id}</span>（{ROSTER_LAST.name}）の{ROSTER.length}通りです。
              </div>
              <a
                href={`/staff/${ROSTER_FIRST.id}`}
                target="_blank"
                rel="noopener"
                style={{
                  justifySelf: "start",
                  minHeight: 44,
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "0 14px",
                  borderRadius: 9,
                  border: `1px solid ${DAY.line}`,
                  background: DAY.page,
                  color: DAY.text,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                /staff/{ROSTER_FIRST.id}（{ROSTER_FIRST.name}）を開いてみる
              </a>
              <div style={{ fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
                接続していないメンバーにも、先に配置指示を出せます（名簿の行を選んでください）。
              </div>
            </div>
          )}

          {ROSTER_BY_GROUP.map(([group, members]) => (
            <div key={group}>
              <div style={{ fontSize: 15, fontWeight: 700, margin: "4px 0" }}>{group}</div>
              <div style={{ display: "grid", gap: 6 }}>
                {members.map((m) => (
                  <MemberRow
                    key={m.id}
                    info={{ id: m.id, name: m.name, role: m.role }}
                    staff={staffByName.get(m.name)}
                    dispatch={latestDispatchFor(m.name, dispatches)}
                    selected={selName === m.name}
                    onToggle={handleListSelect}
                    registerRef={registerRef}
                  />
                ))}
              </div>
            </div>
          ))}

          {offRoster.length > 0 && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, margin: "4px 0" }}>名簿外</div>
              <div style={{ display: "grid", gap: 6 }}>
                {offRoster.map((s) => (
                  <MemberRow
                    key={s.name}
                    info={{ id: encodeURIComponent(s.name), name: s.name, role: s.role }}
                    staff={s}
                    dispatch={latestDispatchFor(s.name, dispatches)}
                    selected={selName === s.name}
                    onToggle={handleListSelect}
                    registerRef={registerRef}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── マップ ── */}
        <div ref={mapRef} style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <VenueMap
            zones={zonesFor("in")}
            hour={hour}
            scenario={scenario}
            layer="crowd"
            staff={board.marks}
            onStaffClick={handleStaffClick}
            selectedStaffIndex={selStaffIndex}
            onZoneClick={selName ? handleZoneClick : undefined}
            zoneBadges={board.zoneBadges}
            dimmedStaffIndices={board.dimmedIdx}
            ghostMarks={board.ghosts}
          />

          {/* 凡例 */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, color: DAY.textFaint }}>
            <LegendDot color={ROLE_COLOR.water} label="給水" />
            <LegendDot color={ROLE_COLOR.guide} label="誘導" />
            <LegendDot color={ROLE_COLOR.aid} label="救護" />
            <LegendDot color={ROLE_COLOR.reception} label="受付" />
            <span>薄い丸=空席</span>
            <span>点線丸=指示中（グレー=未応答/青=移動中）</span>
          </div>

          {unanswered.length > 0 && (
            <div style={{ fontSize: 13, color: DAY.danger, display: "grid", gap: 2 }}>
              {unanswered.map((d) => (
                <div key={d.id}>
                  ⚠ {d.staffName}への指示（{d.toZoneName}）が10分以上未達 — 再送か無線確認を
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 指示の最終確認モーダル（配信の唯一の入口 = /api/dispatch） */}
      {modalOpen && (
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="配置指示の最終確認"
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
          <div style={{ background: "#FFFFFF", borderRadius: 14, padding: 20, maxWidth: 420, width: "100%", display: "grid", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: DAY.text }}>配置指示の最終確認</h3>
            <p style={{ margin: 0, fontSize: 15, color: DAY.text }}>
              <b>{selName}</b> を <b>{postCodeLabel(selStaff?.postCode ?? "")} → {targetZoneName}</b> へ
            </p>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, color: DAY.textDim, fontWeight: 700 }}>移動先ポスト</span>
              <select
                value={selectedPostCode}
                onChange={(e) => setSelectedPostCode(e.target.value)}
                aria-label="移動先ポスト"
                style={{ minHeight: 44, borderRadius: 9, border: `1px solid ${DAY.line}`, padding: "0 10px", fontSize: 13, color: DAY.text, background: "#FFF" }}
              >
                <option value="">ポスト指定なし</option>
                {zonePosts.map((p) => {
                  const occupied = staffList.some((s) => isAssignedTo(s.postCode, p.code));
                  return (
                    <option key={p.code} value={p.code}>
                      {p.code}（{occupied ? "使用中" : "空き"}）
                    </option>
                  );
                })}
              </select>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="理由（任意）"
              aria-label="移動の理由（任意）"
              style={{ minHeight: 44, borderRadius: 9, border: `1px solid ${DAY.line}`, padding: "0 10px", fontSize: 13, color: DAY.text }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setUrgency("now")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 9,
                  border: urgency === "now" ? `2px solid ${DAY.danger}` : `1px solid ${DAY.line}`,
                  background: urgency === "now" ? "#FCE8ED" : "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                いますぐ
              </button>
              <button
                onClick={() => setUrgency("soon")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 9,
                  border: urgency === "soon" ? `2px solid ${DAY.text}` : `1px solid ${DAY.line}`,
                  background: urgency === "soon" ? "#EEF1F7" : "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                手すきで
              </button>
            </div>
            {error && <div style={{ fontSize: 13, color: DAY.danger }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={submitDispatch}
                disabled={busy}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 10,
                  border: "none",
                  background: busy ? "#93A3C0" : DAY.text,
                  color: "#FFF",
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {busy ? "配信中…" : "指示を配信"}
              </button>
              <button
                onClick={cancelMove}
                disabled={busy}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 10,
                  border: `1px solid ${DAY.line}`,
                  background: "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: busy ? "wait" : "pointer",
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

/** 名簿1行分。ROSTER・名簿外いずれも同じ形で描く */
function MemberRow({
  info,
  staff,
  dispatch,
  selected,
  onToggle,
  registerRef,
}: {
  info: RowInfo;
  staff: Staff | undefined;
  dispatch: Dispatch | undefined;
  selected: boolean;
  onToggle: (name: string) => void;
  registerRef: (name: string, el: HTMLDivElement | null) => void;
}) {
  const badge = memberBadge(staff, dispatch, Date.now());
  const style = STATUS_STYLE[badge.status];
  const active = dispatch && (dispatch.status === "sent" || dispatch.status === "moving") ? dispatch : undefined;

  return (
    <div
      ref={(el) => registerRef(info.name, el)}
      role="button"
      tabIndex={0}
      onClick={() => onToggle(info.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(info.name);
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 48,
        padding: "6px 10px",
        borderRadius: 10,
        border: selected ? `2px solid ${DAY.text}` : `1px solid ${DAY.line}`,
        background: DAY.surface,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          minWidth: 26,
          borderRadius: 13,
          background: ROLE_COLOR[info.role],
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          color: info.role === "guide" ? DAY.text : "#FFFFFF",
        }}
      >
        {info.name.charAt(0)}
      </span>

      <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {info.name} <span style={{ fontSize: 13, fontWeight: 400, color: DAY.textFaint }}>{ROLE_LABEL[info.role]}</span>
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span
            style={{
              display: "inline-block",
              padding: "1px 8px",
              borderRadius: 999,
              border: `1px solid ${style.border}`,
              background: style.bg,
              color: style.text,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {style.label}
          </span>
          {badge.stale && <Chip label="古い" color={DAY.danger} bg="#FCE8ED" />}
          {badge.unanswered && <Chip label="未応答" color="#B45309" bg="#FFF3E4" />}
        </span>
        <span style={{ fontSize: 13, color: DAY.textFaint }}>
          {postCodeLabel(staff?.postCode ?? "")}
          {active && (
            <>
              {" → "}
              {active.toZoneName}
              {active.toPostCode ? `(${active.toPostCode})` : ""}
              （{active.status === "moving" ? "移動中" : "未応答"}）
            </>
          )}
        </span>
      </span>

      <a
        href={`/staff/${info.id}`}
        target="_blank"
        rel="noopener"
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 44,
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          color: DAY.textDim,
          textDecoration: "none",
          border: `1px solid ${DAY.line}`,
          borderRadius: 8,
          padding: "0 10px",
        }}
      >
        開く
      </a>
    </div>
  );
}

function Pill({ label, n, color, bg }: { label: string; n: number; color: string; bg: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      {label} <span className="cw-mono">{n}</span>
    </span>
  );
}

function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{ display: "inline-block", padding: "1px 6px", borderRadius: 999, background: bg, color, fontSize: 13, fontWeight: 700 }}>
      {label}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 999, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
