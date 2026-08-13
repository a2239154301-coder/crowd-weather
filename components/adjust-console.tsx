"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { useScenario } from "@/lib/ui/scenario-context";
import { centroid, dayPlan, forecastZones } from "@/lib/forecast/model";
import { HOURS, VENUE, zonesFor } from "@/lib/forecast/venue";
import type { Zone } from "@/lib/forecast/types";
import { postsFor, ROLE_LABEL, zoneById, type Post } from "@/lib/ops/staffing";
import VenueMap, { type StaffMark } from "./venue-map";
import {
  fuseObservations,
  correctionFactor,
  correctedDensity,
  type Observation,
} from "@/lib/forecast/nowcast";
import { evidenceLabel, evidencePlain } from "@/lib/forecast/evidence";
import SourceTag from "./source-tag";
import { applyDemand } from "@/lib/forecast/demand";
import { timetableContext } from "@/lib/data/timetable";
import { CAMERAS, latestFrames, cameraSeries } from "@/lib/data/camera";
import { historyCurves } from "@/lib/data/history";
import { simulateEgress, defaultEgress, regulatedEgress } from "@/lib/forecast/egress";
import type { Dispatch, Report, Staff } from "@/lib/ops/store";

/**
 * 調整コンソール — 計画と実際のAdjustmentを行う司令塔（当日モード「調整」ビュー）。
 *
 * 5つの部品で「観測 → 統合 → 補正 → 提案 → 承認・配信」のループを1画面に収める:
 *  1. 観測フィード（スタッフ報告＋カメラ実測。デモデータは明記）
 *  2. 分析チャート（予測 × カメラ × 報告 × 補正後 の重ね描き）
 *  3. 配置ボード（ポスト×スタッフ状態。古い状態の明示・手動補正）
 *  4. AI提案（/api/propose）→ 4'. 人間の承認 → /api/dispatch 配信
 *
 * 統合・補正は決定的（nowcast.ts）。LLMは報告の構造化と提案起草だけ（CLAUDE.md改訂ルール）。
 */

const POLL_MS = 5000;

type Proposal = {
  staffName: string;
  fromCode: string;
  toZoneId: string;
  action: string;
  urgency: string;
  reason: string;
};

export default function AdjustConsole() {
  const { scenario } = useScenario();
  const [hour, setHour] = useState(15);
  const [zoneSel, setZoneSel] = useState("wg");

  const [reports, setReports] = useState<Report[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  // 写真ナウキャスト: 採用済みの写真観測（人間確認を経たものだけが観測に入る）
  const [photoObs, setPhotoObs] = useState<Observation[]>([]);
  const [proposalNote, setProposalNote] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMetaLine, setAiMetaLine] = useState("");

  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const posts = useMemo(() => postsFor(plan), [plan]);
  const nowMinutes = hour * 60;

  // カメラの絶対値化に使う「現シナリオの予測」関数（時刻間は線形補間・時刻ごとにメモ）
  const densityOf = useMemo(() => {
    const cache = new Map<number, Map<string, number>>();
    const byHour = (h: number) => {
      let m = cache.get(h);
      if (!m) {
        m = new Map(
          forecastZones(VENUE.zones, h, scenario).map((f) => [
            f.zone.id,
            applyDemand(f.zone, f.density, h),
          ])
        );
        cache.set(h, m);
      }
      return m;
    };
    return (zoneId: string, hourFloat: number) => {
      const h0 = Math.max(VENUE.open, Math.floor(hourFloat));
      const h1 = Math.min(VENUE.close, h0 + 1);
      const t = hourFloat - h0;
      const d0 = byHour(h0).get(zoneId) ?? 0;
      const d1 = byHour(h1).get(zoneId) ?? 0;
      return d0 * (1 - t) + d1 * t;
    };
  }, [scenario]);

  // ── ポーリング（報告・スタッフ・指示） ──
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [r1, r2, r3] = await Promise.all([
          fetch("/api/report").then((r) => r.json()),
          fetch("/api/staff").then((r) => r.json()),
          fetch("/api/dispatch").then((r) => r.json()),
        ]);
        if (!alive) return;
        if (Array.isArray(r1.reports)) setReports(r1.reports);
        if (Array.isArray(r2.staff)) setStaffList(r2.staff);
        if (Array.isArray(r3.dispatches)) setDispatches(r3.dispatches);
      } catch {
        /* 次周期 */
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ── 観測の組み立て（カメラ=デモデータ・報告=store） ──
  const observations = useMemo<Observation[]>(() => {
    const obs: Observation[] = latestFrames(nowMinutes, densityOf).map((f) => ({
      zoneId: f.zoneId,
      minutes: f.minutes,
      impliedDensity: f.impliedDensity,
      source: "camera" as const,
    }));
    // スタッフ報告: 1-5 → 指数換算（1→15 / 2→35 / 3→55 / 4→75 / 5→95）。crowd系のみ密度観測になる
    for (const r of reports) {
      if (r.kind !== "crowd") continue;
      obs.push({
        zoneId: r.zoneId,
        minutes: nowMinutes, // 報告は「いま」の観測として扱う（デモは実時刻とシミュ時刻が混ざるため）
        impliedDensity: 15 + (r.level - 1) * 20,
        source: r.source,
      });
    }
    // 写真観測（人間が「採用」したものだけ）
    for (const p of photoObs) obs.push(p);
    return obs;
  }, [nowMinutes, reports, densityOf, photoObs]);

  // ── 予測と補正（決定的） ──
  const zones = VENUE.zones;
  const corrected = useMemo(() => {
    const fc = forecastZones(zones, hour, scenario);
    return fc.map((f) => {
      const withDemand = applyDemand(f.zone, f.density, hour);
      const fusion = fuseObservations(observations, f.zone.id, nowMinutes);
      const age = fusion.latestMinutes === null ? Infinity : nowMinutes - fusion.latestMinutes;
      const factor = correctionFactor(fusion.fusedDensity, withDemand, age === Infinity ? 999 : age);
      return {
        zone: f.zone,
        predicted: withDemand,
        observed: fusion.fusedDensity,
        conflict: fusion.conflict,
        correctedValue: correctedDensity(withDemand, factor),
        factor,
      };
    });
  }, [zones, hour, scenario, observations, nowMinutes]);

  const bigGaps = corrected
    .filter((c) => Math.abs(c.correctedValue - c.predicted) >= 10)
    .sort((a, b) => Math.abs(b.correctedValue - b.predicted) - Math.abs(a.correctedValue - a.predicted));

  // ── AI提案 ──
  const askProposal = useCallback(async () => {
    setAiBusy(true);
    setProposals(null);
    setProposalNote("");
    const t0 = Date.now();
    try {
      const context = {
        hour: `${hour}:00`,
        timetable: timetableContext(hour),
        risky: corrected
          .filter((c) => c.correctedValue >= 60)
          .map((c) => ({
            zoneId: c.zone.id,
            zone: c.zone.name,
            予測: c.predicted,
            補正後: c.correctedValue,
            観測あり: c.observed !== null,
            食い違い: c.conflict,
          })),
        現在配置: staffList.map((s) => ({
          name: s.name,
          post: s.postCode,
          zone: zoneById(s.zoneId)?.name ?? s.zoneId,
          role: ROLE_LABEL[s.role],
          state: s.state,
        })),
        直近の報告: reports.slice(0, 6).map((r) => `${zoneById(r.zoneId)?.name}: ${r.summary}（${r.name}）`),
      };
      const res = await fetch("/api/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      setProposals(data.proposals ?? []);
      setProposalNote(data.note ?? "");
      const served = data.meta?.resolvedModel ?? data.meta?.servedModel ?? "";
      setAiMetaLine(`${served} ／ ${((Date.now() - t0) / 1000).toFixed(1)}s${data.rejected ? ` ／ 範囲外提案${data.rejected}件を棄却` : ""}`);
    } catch {
      setProposalNote("提案を取得できませんでした");
      setProposals([]);
    } finally {
      setAiBusy(false);
    }
  }, [hour, corrected, staffList, reports]);

  /** 承認 = このボタンだけが配信の入口（AIは提案まで）。連打による重複配信を防ぐ */
  const [approving, setApproving] = useState<Proposal | null>(null);
  async function approve(p: Proposal) {
    if (approving) return;
    setApproving(p);
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProposalNote(`配信できませんでした: ${data?.error ?? res.status}`);
        return;
      }
      setProposals((prev) => (prev ? prev.filter((x) => x !== p) : prev));
    } finally {
      setApproving(null);
    }
  }

  const selZone = zoneById(zoneSel);
  const stale = (s: Staff) => Date.now() - s.updatedAt > 15 * 60_000;

  // ── 配置ボードの全体マップ（タップ2回で移動指示・2026-08-13 追加） ──
  // 入場済みスタッフは zoneId から位置を引く（postCode は「着きました」応答で
  // 「元コード→」形式に書き換わるため、位置決めには使えない — staff-console.tsx:117 参照）。
  // 空席ポストは「そのゾーンのポスト数 − 入場済み人数」の残りをそのまま空席マークにする
  // （個々のポストコードとの厳密な対応は追わない。同じ理由で追えない）。
  const { marks, entryStaff, dimmedIdx, zoneBadges } = useMemo(() => {
    const marksArr: StaffMark[] = [];
    const entries: (Staff | null)[] = [];
    const dimmed = new Set<number>();
    const badges: Record<string, number> = {};

    const byZone = new Map<string, Staff[]>();
    for (const s of staffList) {
      // presence登録（配置待ち）はマップに描かない（zoneId空はまだ実配置ではない）
      if (!s.zoneId) continue;
      const arr = byZone.get(s.zoneId) ?? [];
      arr.push(s);
      byZone.set(s.zoneId, arr);
      badges[s.zoneId] = (badges[s.zoneId] ?? 0) + 1;
    }

    byZone.forEach((list, zoneId) => {
      const basePost = posts.find((p) => p.zoneId === zoneId);
      const zone = zoneById(zoneId);
      const base = basePost?.at ?? (zone ? centroid(zone.shape) : { x: 0, y: 0 });
      list.forEach((s, i) => {
        marksArr.push({
          at: { x: base.x + (i - (list.length - 1) / 2) * 34, y: base.y },
          role: s.role,
          label: s.postCode,
        });
        entries.push(s);
      });
    });

    const postsByZone = new Map<string, Post[]>();
    for (const p of posts) {
      const arr = postsByZone.get(p.zoneId) ?? [];
      arr.push(p);
      postsByZone.set(p.zoneId, arr);
    }
    postsByZone.forEach((zonePosts, zoneId) => {
      const occupied = byZone.get(zoneId)?.length ?? 0;
      for (const p of zonePosts.slice(occupied)) {
        dimmed.add(marksArr.length);
        marksArr.push({ at: p.at, role: p.role, label: p.code });
        entries.push(null);
      }
    });

    return { marks: marksArr, entryStaff: entries, dimmedIdx: dimmed, zoneBadges: badges };
  }, [staffList, posts]);

  const [selStaff, setSelStaff] = useState<Staff | null>(null);
  const [moveTarget, setMoveTarget] = useState<Zone | null>(null);
  const [moveReason, setMoveReason] = useState("");
  const [moveUrgency, setMoveUrgency] = useState<"now" | "soon">("soon");
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [dispatchNotice, setDispatchNotice] = useState("");

  // 選択中スタッフをポーリング最新値へ同期する（fromCode が古いまま配信されるのを防ぐ）
  useEffect(() => {
    if (!selStaff) return;
    const fresh = staffList.find((s) => s.name === selStaff.name);
    if (!fresh) {
      setSelStaff(null);
      return;
    }
    if (fresh !== selStaff) setSelStaff(fresh);
  }, [staffList, selStaff]);

  useEffect(() => {
    if (!dispatchNotice) return;
    const t = setTimeout(() => setDispatchNotice(""), 6000);
    return () => clearTimeout(t);
  }, [dispatchNotice]);

  const selStaffIndex = selStaff ? entryStaff.findIndex((s) => s?.name === selStaff.name) : null;

  const handleStaffClick = useCallback(
    (i: number) => {
      const s = entryStaff[i];
      if (!s) return;
      setSelStaff((prev) => (prev && prev.name === s.name ? null : s));
    },
    [entryStaff]
  );

  const handleZoneClick = useCallback(
    (zoneId: string) => {
      if (!selStaff) return;
      const z = zoneById(zoneId);
      if (!z) return;
      setMoveTarget(z);
      setMoveReason("");
      setMoveUrgency("soon");
      setMoveError("");
    },
    [selStaff]
  );

  function cancelMove() {
    if (moveBusy) return;
    setMoveTarget(null);
    setMoveError("");
  }

  async function submitMove() {
    if (!selStaff || !moveTarget || moveBusy) return;
    setMoveBusy(true);
    setMoveError("");
    try {
      const reason = moveReason.trim();
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffName: selStaff.name,
          fromCode: selStaff.postCode,
          toZoneId: moveTarget.id,
          action: reason || "応援に入ってください",
          urgency: moveUrgency,
          reason: reason || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMoveError(`配信できませんでした: ${data?.error ?? res.status}`);
        return;
      }
      setSelStaff(null);
      setMoveTarget(null);
      setMoveReason("");
      setMoveUrgency("soon");
      setDispatchNotice("配信しました。スタッフの応答は受信箱→盤面に反映されます");
    } catch {
      setMoveError("配信できませんでした: 通信エラー");
    } finally {
      setMoveBusy(false);
    }
  }

  return (
    <div style={{ background: DAY.page, color: DAY.text, borderRadius: 16, border: `1px solid ${DAY.line}`, padding: 14, display: "grid", gap: 12 }}>
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
        <span style={{ fontSize: 13, color: DAY.textFaint }}>カメラ・過去実績は（デモデータ）</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
        {/* ── 1. 観測フィード ── */}
        <section style={panel}>
          <h3 style={h3}>観測フィード</h3>
          <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 6 }}>カメラ実測（デモデータ・5分間隔）</div>
          {latestFrames(nowMinutes, densityOf).map((f) => {
            const cam = CAMERAS.find((c) => c.id === f.cameraId)!;
            return (
              <div key={f.cameraId} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: `1px solid ${DAY.line}` }}>
                <span style={{ flex: 1 }}>{cam.name}</span>
                <span className="cw-mono">{f.count}人</span>
                <span className="cw-mono" style={{ color: DAY.textDim }}>指数{f.impliedDensity}</span>
              </div>
            );
          })}
          <div style={{ fontSize: 13, color: DAY.textFaint, margin: "10px 0 6px" }}>スタッフ報告（構造化済み）</div>
          {reports.length === 0 && <div style={{ fontSize: 13, color: DAY.textDim }}>まだ報告はありません</div>}
          {reports.slice(0, 6).map((r) => (
            <div
              key={r.id}
              style={{
                borderLeft: `4px solid ${r.level >= 4 ? "#E5254A" : r.level === 3 ? "#FB7A1E" : "#22C55E"}`,
                background: "#F7F9FC",
                borderRadius: "0 8px 8px 0",
                padding: "6px 9px",
                marginBottom: 6,
                fontSize: 13,
              }}
            >
              <b>{r.summary}</b>
              <div style={{ color: DAY.textFaint, fontSize: 13 }}>
                {r.name}・{new Date(r.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                {r.source === "staff-text" ? "・自由文→AI構造化" : ""}
              </div>
            </div>
          ))}
          <PhotoObsInput
            nowMinutes={nowMinutes}
            onAdopt={(o) => setPhotoObs((prev) => [...prev, o])}
          />
        </section>

        {/* ── 2. 計画と実際のずれ ── */}
        <section style={panel}>
          <h3 style={{ ...h3, display: "flex", alignItems: "center", gap: 8 }}>
            計画と実際のずれ（ナウキャスト補正）
            <SourceTag kind="calc" tone="day" />
          </h3>
          {bigGaps.length === 0 && (
            <div style={{ fontSize: 13, color: DAY.textDim }}>予測と観測に大きなずれはありません（±10未満）</div>
          )}
          {bigGaps.slice(0, 5).map((c) => (
            <button
              key={c.zone.id}
              onClick={() => setZoneSel(c.zone.id)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "#FFF", border: `1px solid ${DAY.line}`, borderRadius: 9, padding: "8px 10px", marginBottom: 6, cursor: "pointer" }}
            >
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {c.zone.name} 予測{c.predicted} → <span style={{ color: c.correctedValue > c.predicted ? DAY.danger : "#0F6E56" }}>補正{c.correctedValue}</span>
                {c.conflict && <span style={{ marginLeft: 6, fontSize: 13, color: DAY.danger }}>観測が食い違い→無線確認</span>}
              </div>
              <div title={evidenceLabel(c.zone.kind, c.correctedValue)} style={{ fontSize: 13, color: DAY.textFaint }}>{evidencePlain(c.zone.kind, c.correctedValue)}・クリックでチャート</div>
            </button>
          ))}
          {/* 分析チャート */}
          {selZone && (
            <AnalysisChart
              zoneId={zoneSel}
              zoneName={selZone.name}
              hour={hour}
              scenario={scenario}
              observations={observations}
              reports={reports}
              densityOf={densityOf}
            />
          )}
        </section>

        {/* ── 3. 配置ボード ── */}
        <section style={panel}>
          <h3 style={h3}>配置ボード</h3>
          {dispatchNotice && (
            <div
              style={{
                background: "#EAF7F1",
                border: "1px solid #0F6E56",
                borderRadius: 9,
                padding: "8px 10px",
                fontSize: 13,
                color: "#0F6E56",
                marginBottom: 8,
              }}
            >
              {dispatchNotice}
            </div>
          )}
          <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 6 }}>
            申告の最終状態＋時刻。15分更新なしは「古い」。マップのスタッフをタップ→移動先ゾーンをタップで、移動指示を出せます（配信前に必ず確認画面）。
          </div>
          {posts.map((p: Post) => {
            const assigned = staffList.filter((s) => s.postCode.startsWith(p.code));
            return (
              <div key={p.code} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${DAY.line}`, fontSize: 13 }}>
                <span className="cw-mono" style={{ width: 40, fontWeight: 700 }}>{p.code}</span>
                <span style={{ flex: 1 }}>{p.zoneName}・{ROLE_LABEL[p.role]}</span>
                {assigned.length === 0 ? (
                  <span style={{ color: DAY.danger, fontWeight: 700, fontSize: 13 }}>空席</span>
                ) : (
                  assigned.map((s) => (
                    <span key={s.name} style={{ fontSize: 13 }}>
                      {s.name}
                      <b style={{ marginLeft: 4, color: s.state === "onpost" ? "#0F6E56" : s.state === "moving" ? "#B45309" : DAY.danger }}>
                        {s.state === "onpost" ? "着任" : s.state === "moving" ? "移動中" : "離脱"}
                      </b>
                      {stale(s) && <span style={{ color: DAY.danger, fontSize: 13 }}>（古い）</span>}
                    </span>
                  ))
                )}
              </div>
            );
          })}
          {/* 未達の指示 */}
          {dispatches.filter((d) => d.status === "sent" && Date.now() - d.createdAt > 10 * 60_000).map((d) => (
            <div key={d.id} style={{ marginTop: 8, fontSize: 13, color: DAY.danger }}>
              ⚠ {d.staffName}への指示（{d.toZoneName}）が10分以上未達 — 再送か無線確認を
            </div>
          ))}

          {/* 全体マップ（タップ2回で移動指示） */}
          <div style={{ marginTop: 12 }}>
            {selStaff && (
              <div
                style={{
                  background: DAY.text,
                  color: "#FFFFFF",
                  borderRadius: 9,
                  padding: "0 12px",
                  fontSize: 13,
                  fontWeight: 700,
                  minHeight: 44,
                  display: "flex",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                {selStaff.name}（{selStaff.postCode}）を選択中 — 移動先のゾーンをタップ。もう一度タップで解除
              </div>
            )}
            <VenueMap
              zones={zonesFor("in")}
              hour={hour}
              scenario={scenario}
              layer="crowd"
              staff={marks}
              onStaffClick={handleStaffClick}
              selectedStaffIndex={selStaffIndex}
              onZoneClick={selStaff ? handleZoneClick : undefined}
              zoneBadges={zoneBadges}
              dimmedStaffIndices={dimmedIdx}
            />
            <div style={{ display: "flex", gap: 12, fontSize: 13, color: DAY.textFaint, marginTop: 6, flexWrap: "wrap" }}>
              <span>水=給水</span>
              <span>誘=誘導</span>
              <span>救=救護</span>
              <span>薄い丸=空席</span>
            </div>
          </div>
        </section>

        {/* ── 4. AI提案 → 承認 → 配信 ── */}
        <section style={{ ...panel, borderColor: DAY.text, borderWidth: 2 }}>
          <h3 style={{ ...h3, display: "flex", alignItems: "center", gap: 8 }}>
            AI配置提案（承認するまで配信されない）
            <SourceTag kind="ai" tone="day" />
          </h3>
          <button onClick={askProposal} disabled={aiBusy} style={{ width: "100%", minHeight: 52, borderRadius: 10, border: "none", background: aiBusy ? "#93A3C0" : DAY.text, color: "#FFF", fontSize: 15, fontWeight: 700, cursor: aiBusy ? "wait" : "pointer" }}>
            {aiBusy ? "起草中…" : "観測と予報から提案を作る"}
          </button>
          {aiMetaLine && <div className="cw-mono" style={{ fontSize: 13, color: DAY.textFaint, marginTop: 4 }}>{aiMetaLine}</div>}
          {proposalNote && <p style={{ margin: "8px 0 0", fontSize: 13, color: DAY.textDim }}>{proposalNote}</p>}
          {proposals?.map((p, i) => (
            <div key={i} style={{ background: "#FFF", border: `1px solid ${DAY.line}`, borderRadius: 10, padding: "10px 12px", marginTop: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {p.fromCode} {p.staffName} → {zoneById(p.toZoneId)?.name ?? p.toZoneId}
                {p.urgency === "now" && <span style={{ marginLeft: 6, color: DAY.danger, fontSize: 13 }}>いますぐ</span>}
              </div>
              <div style={{ fontSize: 13, margin: "2px 0" }}>{p.action}</div>
              <div style={{ fontSize: 13, color: DAY.textFaint }}>{p.reason}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button onClick={() => approve(p)} disabled={approving !== null} style={{ flex: 1, minHeight: 44, borderRadius: 9, border: "none", background: approving ? "#93A3C0" : DAY.text, color: "#FFF", fontWeight: 700, fontSize: 15, cursor: approving ? "wait" : "pointer" }}>
                  {approving === p ? "配信中…" : "承認して配信"}
                </button>
                <button onClick={() => setProposals((prev) => (prev ? prev.filter((x) => x !== p) : prev))} style={{ flex: 1, minHeight: 44, borderRadius: 9, border: `1px solid ${DAY.line}`, background: "#FFF", fontSize: 15, cursor: "pointer" }}>
                  却下
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>

      {/* ── 5. 退場シミュレーション（人流モデル・決定的） ── */}
      <EgressPanel tickets={scenario.tickets} />

      {/* 移動指示の最終確認モーダル（配信の唯一の入口 = /api/dispatch。人間承認の不変条件） */}
      {selStaff && moveTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="移動指示の最終確認"
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
              maxWidth: 420,
              width: "100%",
              display: "grid",
              gap: 12,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: DAY.text }}>移動指示の最終確認</h3>
            <p style={{ margin: 0, fontSize: 15, color: DAY.text }}>
              <b>{selStaff.name}</b> を <b>{selStaff.postCode} → {moveTarget.name}</b> へ
            </p>
            <input
              type="text"
              value={moveReason}
              onChange={(e) => setMoveReason(e.target.value)}
              placeholder="例）西ゲートの列が伸びているため"
              aria-label="移動の理由（任意）"
              style={{
                minHeight: 44,
                borderRadius: 9,
                border: `1px solid ${DAY.line}`,
                padding: "0 10px",
                fontSize: 13,
                color: DAY.text,
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setMoveUrgency("now")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 9,
                  border: moveUrgency === "now" ? `2px solid ${DAY.danger}` : `1px solid ${DAY.line}`,
                  background: moveUrgency === "now" ? "#FCE8ED" : "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                いますぐ
              </button>
              <button
                onClick={() => setMoveUrgency("soon")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 9,
                  border: moveUrgency === "soon" ? `2px solid ${DAY.text}` : `1px solid ${DAY.line}`,
                  background: moveUrgency === "soon" ? "#EEF1F7" : "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                手すきで
              </button>
            </div>
            {moveError && <div style={{ fontSize: 13, color: DAY.danger }}>{moveError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={submitMove}
                disabled={moveBusy}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 10,
                  border: "none",
                  background: moveBusy ? "#93A3C0" : DAY.text,
                  color: "#FFF",
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: moveBusy ? "wait" : "pointer",
                }}
              >
                {moveBusy ? "配信中…" : "指示を配信"}
              </button>
              <button
                onClick={cancelMove}
                disabled={moveBusy}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: 10,
                  border: `1px solid ${DAY.line}`,
                  background: "#FFF",
                  color: DAY.text,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: moveBusy ? "wait" : "pointer",
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

/**
 * 写真ナウキャスト — ゾーン写真をAIで1-5レベルに分類し、**人間が確認してから**観測に採用する。
 *
 * 人数カウントはしない（Vision LLMの群集カウントは高密度で精度が出ない=研究コンセンサス。
 * /api/photo-obs 参照）。分類の確信度も表示し、採用の判断は人間に残す。
 */
function PhotoObsInput({
  nowMinutes,
  onAdopt,
}: {
  nowMinutes: number;
  onAdopt: (o: Observation) => void;
}) {
  const [zoneSel, setZoneSel] = useState("wg");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    level: number;
    description: string;
    confidence: string;
    crowdVisible: boolean;
  } | null>(null);
  const [note, setNote] = useState("");

  /** ingest-panel と同じ流儀: 長辺1024pxへ縮小してJPEG化してから送る */
  async function toResizedDataUrl(file: File): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const long = Math.max(img.width, img.height);
      const scale = long > 1024 ? 1024 / long : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function classify(file: File) {
    setBusy(true);
    setPending(null);
    setNote("");
    try {
      const imageDataUrl = await toResizedDataUrl(file);
      const res = await fetch("/api/photo-obs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      if (!data.result.crowdVisible) {
        setNote("群集が判定できない写真でした（無人・ブレ等）。別の写真をどうぞ");
        return;
      }
      setPending(data.result);
    } catch {
      setNote("分類できませんでした（通信・APIキーを確認）");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${DAY.line}`, paddingTop: 8 }}>
      <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 6 }}>
        写真ナウキャスト（AIは1-5分類まで・採用は人間）
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={zoneSel}
          onChange={(e) => setZoneSel(e.target.value)}
          aria-label="写真のゾーン"
          style={{ minHeight: 44, borderRadius: 9, border: `1px solid ${DAY.line}`, background: "#FFF", color: DAY.text, fontSize: 13, padding: "0 8px" }}
        >
          {VENUE.zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
        <label
          style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 14px", borderRadius: 9, border: `1px solid ${DAY.line}`, background: "#FFF", fontSize: 13, fontWeight: 700, cursor: busy ? "wait" : "pointer" }}
        >
          {busy ? "分類中…" : "写真を選ぶ"}
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) classify(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {note && <div style={{ fontSize: 13, color: DAY.textDim, marginTop: 6 }}>{note}</div>}
      {pending && (
        <div style={{ background: "#FFF", border: `1px solid ${DAY.line}`, borderRadius: 10, padding: "9px 11px", marginTop: 8 }}>
          <div style={{ fontSize: 15 }}>
            AI分類: <b>レベル{pending.level}</b>（確信度 {pending.confidence === "high" ? "高" : pending.confidence === "low" ? "低" : "中"}）
          </div>
          <div style={{ fontSize: 13, color: DAY.textDim }}>{pending.description}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              onClick={() => {
                onAdopt({
                  zoneId: zoneSel,
                  minutes: nowMinutes,
                  impliedDensity: 15 + (pending.level - 1) * 20,
                  source: "photo",
                });
                setPending(null);
                setNote("観測として採用しました（信頼度重みは最小の0.5）");
              }}
              style={{ flex: 1, minHeight: 44, borderRadius: 9, border: "none", background: DAY.text, color: "#FFF", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
            >
              観測に採用
            </button>
            <button
              onClick={() => setPending(null)}
              style={{ flex: 1, minHeight: 44, borderRadius: 9, border: `1px solid ${DAY.line}`, background: "#FFF", fontSize: 13, cursor: "pointer" }}
            >
              破棄
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 退場波及モデルのパネル — 「人がどう流れるか」の実体（D-2）。
 * ゾーン隣接グラフ＋Fruin流動容量のネットワーク流で、一斉退場と規制退場を並べる。
 * 雑踏警備の実務（規制退場の効果）が数字で見える。
 */
function EgressPanel({ tickets }: { tickets: number }) {
  const [open, setOpen] = useState(false);
  const result = useMemo(() => {
    if (!open) return null;
    const free = simulateEgress(defaultEgress(tickets));
    const reg = simulateEgress(regulatedEgress(tickets));
    return { free, reg };
  }, [open, tickets]);

  const NODE_LABEL: Record<string, string> = {
    exit: "退場動線",
    plaza: "駅前広場",
    conc: "改札コンコース",
  };

  return (
    <section style={{ ...panel }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ ...h3, margin: 0 }}>退場シミュレーション（終演後の人の流れ）</h3>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ minHeight: 44, padding: "0 16px", borderRadius: 9, border: `1px solid ${DAY.line}`, background: DAY.surface, fontSize: 13, fontWeight: 700, cursor: "pointer", color: DAY.text }}
        >
          {open ? "閉じる" : "計算する"}
        </button>
        <span style={{ fontSize: 13, color: DAY.textFaint }}>
          ネットワーク流＋待ち行列（決定的計算・通路幅と流動係数60人/分/mは想定値）
        </span>
      </div>
      {result && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12, marginTop: 12 }}>
          {(["exit", "plaza", "conc"] as const).map((node) => (
            <div key={node} style={{ background: "#FFF", border: `1px solid ${DAY.line}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{NODE_LABEL[node]}</div>
              <table style={{ width: "100%", fontSize: 13, marginTop: 6, borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ color: DAY.textFaint, padding: "3px 0" }}>一斉退場</td>
                    <td className="cw-mono" style={{ textAlign: "right" }}>
                      ピーク{result.free.peak[node] ? Math.round(result.free.peak[node].value).toLocaleString() : "—"}人（終演+{result.free.peak[node]?.atMin ?? "—"}分）
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: DAY.textFaint, padding: "3px 0" }}>規制退場（3波・10分間隔）</td>
                    <td className="cw-mono" style={{ textAlign: "right", color: "#0F6E56", fontWeight: 700 }}>
                      ピーク{result.reg.peak[node] ? Math.round(result.reg.peak[node].value).toLocaleString() : "—"}人（終演+{result.reg.peak[node]?.atMin ?? "—"}分）
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <div style={{ gridColumn: "1 / -1", fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
            滞留解消: 一斉 {result.free.clearMin}分 ／ 規制 {result.reg.clearMin}分。
            規制退場は解消がやや遅れる代わりにピーク滞留が下がる（ピークが事故を起こす）。
            効果は詰まりが積み上がる箇所（退場動線・改札）に出る。上流の容量で律速される箇所
            （駅前広場）はピークが変わらないことがある — これもモデルが教える実務知識で、
            規制退場の効果を数字で出せることが本モデルの主張。
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 分析チャート — 予測カーブ × カメラ実測 × スタッフ報告 × 補正後 の重ね描き。
 * 「重ねて状況を分析する」の実体。すべて決定的計算（ユーザー指摘 2026-08-13 のデータ統合ビュー）。
 */
function AnalysisChart({
  zoneId,
  zoneName,
  hour,
  scenario,
  observations,
  reports,
  densityOf,
}: {
  zoneId: string;
  zoneName: string;
  hour: number;
  scenario: ReturnType<typeof useScenario>["scenario"];
  observations: Observation[];
  reports: Report[];
  densityOf: (zoneId: string, hourFloat: number) => number;
}) {
  const zone = zoneById(zoneId)!;
  const W = 560;
  const H = 150;
  const padL = 30;
  const padB = 20;
  const x = (h: number) => padL + ((h - HOURS[0]) / (HOURS[HOURS.length - 1] - HOURS[0])) * (W - padL - 10);
  const y = (v: number) => H - padB - (v / 100) * (H - padB - 8);

  const predicted = useMemo(
    () =>
      HOURS.map((h) => ({
        hour: h,
        v: applyDemand(zone, forecastZones([zone], h, scenario)[0].density, h),
      })),
    [zone, scenario]
  );
  const correctedCurve = useMemo(
    () =>
      predicted.map((p) => {
        if (p.hour < hour) return { hour: p.hour, v: p.v };
        const fusion = fuseObservations(observations, zoneId, hour * 60);
        const age = fusion.latestMinutes === null ? 999 : hour * 60 - fusion.latestMinutes + (p.hour - hour) * 60;
        const f = correctionFactor(fusion.fusedDensity, p.v, age);
        return { hour: p.hour, v: correctedDensity(p.v, f) };
      }),
    [predicted, observations, zoneId, hour]
  );
  const camPoints = useMemo(
    () => cameraSeries(zoneId, densityOf).filter((f) => f.minutes <= hour * 60 && f.minutes % 15 === 0),
    [zoneId, hour, densityOf]
  );
  // 過去開催の実績（架空・シード固定）。「過去と重ねて分析」の実体
  const history = useMemo(() => historyCurves(zoneId), [zoneId]);
  const reportPoints = reports.filter((r) => r.zoneId === zoneId && r.kind === "crowd");

  return (
    <div style={{ marginTop: 10 }}>
      {/* 見出しは平易に（08-13 現場フィードバック:「予測 × 実測 × 補正（LOS F相当）」は直感的に読めない）。
          技術表記（人/m²・LOS）は副行の括弧内に残す */}
      <div style={{ fontSize: 15, fontWeight: 700 }}>
        {zoneName}の混雑 — 予報をカメラ・報告で補正中
      </div>
      <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 4 }}>
        いま{evidencePlain(zone.kind, correctedCurve.find((c) => c.hour === hour)?.v ?? 0)}
        （{evidenceLabel(zone.kind, correctedCurve.find((c) => c.hour === hour)?.v ?? 0)}）
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", background: "#FFF", borderRadius: 8, border: `1px solid ${DAY.line}` }} role="img" aria-label={`${zoneName}の予測と実測の時系列`}>
        {[0, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={W - 10} y2={y(v)} stroke={v === 75 ? "#E5254A" : DAY.line} strokeWidth={v === 75 ? 1.2 : 0.8} strokeDasharray={v === 75 ? "4 3" : undefined} />
            <text x={padL - 4} y={y(v) + 3.5} textAnchor="end" fontSize={9} fill={DAY.textFaint}>{v}</text>
          </g>
        ))}
        {/* 過去実績（薄い実線・デモデータ） */}
        {history.map((hcurve, hi) => (
          <polyline
            key={hcurve.label}
            fill="none"
            stroke={hi === 0 ? "#7F77DD" : "#5DCAA5"}
            strokeWidth={1.2}
            opacity={0.55}
            points={hcurve.values.map((v, i) => `${x(HOURS[i])},${y(v)}`).join(" ")}
          />
        ))}
        {/* 予測（点線） */}
        <polyline fill="none" stroke={DAY.textDim} strokeWidth={1.8} strokeDasharray="5 4" points={predicted.map((p) => `${x(p.hour)},${y(p.v)}`).join(" ")} />
        {/* 補正後（実線） */}
        <polyline fill="none" stroke={DAY.text} strokeWidth={2.4} points={correctedCurve.map((p) => `${x(p.hour)},${y(p.v)}`).join(" ")} />
        {/* カメラ実測（点） */}
        {camPoints.map((f) => (
          <circle key={f.minutes} cx={x(f.minutes / 60)} cy={y(f.impliedDensity)} r={2.6} fill="#185FA5" />
        ))}
        {/* スタッフ報告（菱形） */}
        {reportPoints.map((r) => (
          <rect key={r.id} x={x(hour) - 4} y={y(15 + (r.level - 1) * 20) - 4} width={8} height={8} transform={`rotate(45 ${x(hour)} ${y(15 + (r.level - 1) * 20)})`} fill="#D85A30" />
        ))}
        {/* 現在時刻 */}
        <line x1={x(hour)} y1={6} x2={x(hour)} y2={H - padB} stroke={DAY.text} strokeWidth={1.2} strokeDasharray="3 3" />
        {HOURS.filter((h) => h % 2 === 1).map((h) => (
          <text key={h} x={x(h)} y={H - 6} textAnchor="middle" fontSize={9} fill={DAY.textFaint}>{h}</text>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 12, fontSize: 13, color: DAY.textDim, marginTop: 4, flexWrap: "wrap" }}>
        <span>— 補正後</span>
        <span style={{ color: DAY.textFaint }}>-- 予測</span>
        <span style={{ color: "#185FA5" }}>● カメラ（デモ）</span>
        <span style={{ color: "#D85A30" }}>◆ スタッフ報告</span>
        <span style={{ color: DAY.danger }}>-- 危険帯75</span>
        <span style={{ color: "#7F77DD" }}>— 2024実績</span>
        <span style={{ color: "#5DCAA5" }}>— 2025実績</span>
        <span style={{ color: DAY.textFaint }}>（過去実績・カメラはデモデータ）</span>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  background: DAY.surface,
  border: `1px solid ${DAY.line}`,
  borderRadius: 12,
  padding: "12px 14px",
};

const h3: React.CSSProperties = { margin: "0 0 8px", fontSize: 15, fontWeight: 700 };
