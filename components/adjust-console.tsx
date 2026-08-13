"use client";

import { useEffect, useMemo, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { useScenario } from "@/lib/ui/scenario-context";
import { dayPlan, forecastZones } from "@/lib/forecast/model";
import { HOURS, VENUE } from "@/lib/forecast/venue";
import { postsFor, zoneById } from "@/lib/ops/staffing";
import { ROSTER } from "@/lib/data/roster";
import { isAssignedTo, latestDispatchFor, memberBadge } from "@/lib/ops/board";
import {
  fuseObservations,
  correctionFactor,
  correctedDensity,
  type Observation,
} from "@/lib/forecast/nowcast";
import { useNowcast } from "@/lib/ui/use-nowcast";
import { evidenceLabel, evidencePlain } from "@/lib/forecast/evidence";
import SourceTag from "./source-tag";
import { applyDemand } from "@/lib/forecast/demand";
import { CAMERAS, latestFrames, cameraSeries } from "@/lib/data/camera";
import { historyCurves } from "@/lib/data/history";
import { simulateEgress, defaultEgress, regulatedEgress } from "@/lib/forecast/egress";
import type { Dispatch, Report, Staff } from "@/lib/ops/store";
import SyncBadge from "./sync-badge";
import { useSyncStatus } from "@/lib/ui/use-polling";

/**
 * 調整コンソール — 計画と実際のAdjustmentを行う司令塔（当日モード「調整」ビュー）。
 *
 * 「観測 → 統合 → 補正 → 提案 → 承認・配信」のループのうち、観測〜補正までをここで扱う:
 *  1. 観測フィード（スタッフ報告＋カメラ実測。デモデータは明記）
 *  2. 分析チャート（予測 × カメラ × 報告 × 補正後 の重ね描き）
 *  3. 配置サマリー（盤面・メンバーリスト・移動指示は「配置」タブへ移設 2026-08-13）
 *
 * AI提案（/api/propose）→ 人間の承認 → /api/dispatch 配信 は「配置」タブへ移設した
 * （2026-08-13。配信の入口を1箇所に集約するため。実体は components/board/proposal-panel.tsx）。
 * 観測の統合・予測の補正（決定的計算）は両者で共有するため lib/ui/use-nowcast.ts に格上げした。
 *
 * 統合・補正は決定的（nowcast.ts）。LLMは報告の構造化と提案起草だけ（CLAUDE.md改訂ルール）。
 */

const POLL_MS = 5000;

export default function AdjustConsole({ onOpenBoard }: { onOpenBoard?: () => void } = {}) {
  const { scenario } = useScenario();
  const [hour, setHour] = useState(15);
  const [zoneSel, setZoneSel] = useState("wg");

  const [reports, setReports] = useState<Report[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  // 写真ナウキャスト: 採用済みの写真観測（人間確認を経たものだけが観測に入る）
  const [photoObs, setPhotoObs] = useState<Observation[]>([]);

  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const posts = useMemo(() => postsFor(plan), [plan]);
  const nowMinutes = hour * 60;

  // ── 観測の統合・予測の補正（決定的・useNowcastへ集約 2026-08-13）──
  // 元は densityOf/observations/corrected の3つのuseMemoがここに直接あったが、
  // 「配置」タブのAI提案パネルでも同じ統合・補正が要るため共有フックへ格上げした
  // （ロジック自体は1行も変えていない。lib/ui/use-nowcast.ts 参照）
  const { observations, corrected, densityOf } = useNowcast(hour, scenario, reports, photoObs);

  // ── ポーリング（報告・スタッフ・指示） ──
  const sync = useSyncStatus();
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

  const bigGaps = corrected
    .filter((c) => Math.abs(c.correctedValue - c.predicted) >= 10)
    .sort((a, b) => Math.abs(b.correctedValue - b.predicted) - Math.abs(a.correctedValue - a.predicted));

  const selZone = zoneById(zoneSel);

  // ── 配置サマリー（盤面・メンバーリスト・移動指示は「配置」タブへ移設 2026-08-13） ──
  // 配信の入口を配置タブの1箇所に集約するため、旧・配置ボード（マップ+タップ移動+モーダル）は
  // staff-board.tsx へ移した。ここでは集計だけを出す（staff-boardの集計ピルと同じ規則）
  const boardSummary = useMemo(() => {
    const staffByName = new Map(staffList.map((s) => [s.name, s]));
    const now = Date.now();
    const counts = { onpost: 0, moving: 0, waiting: 0, unregistered: 0, away: 0 };
    for (const m of ROSTER) {
      const b = memberBadge(staffByName.get(m.name), latestDispatchFor(m.name, dispatches), now);
      counts[b.status] += 1;
    }
    const vacant = posts.filter((p) => !staffList.some((s) => isAssignedTo(s.postCode, p.code))).length;
    return { ...counts, vacant };
  }, [staffList, dispatches, posts]);

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

        {/* ── 3. 配置サマリー（盤面は「配置」タブへ移設 2026-08-13） ── */}
        <section style={panel}>
          <h3 style={{ ...h3, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            配置サマリー
            <SyncBadge sync={sync} tone="day" />
          </h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {(
              [
                ["着任", boardSummary.onpost, "#0F6E56"],
                ["移動中", boardSummary.moving, "#B45309"],
                ["配置待ち", boardSummary.waiting, "#1D4ED8"],
                ["未接続", boardSummary.unregistered, DAY.textFaint],
                ["空席", boardSummary.vacant, DAY.danger],
              ] as const
            ).map(([label, n, color]) => (
              <span
                key={label}
                style={{
                  border: `1px solid ${DAY.line}`,
                  borderRadius: 999,
                  padding: "4px 10px",
                  fontSize: 13,
                  fontWeight: 700,
                  color,
                }}
              >
                {label} {n}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 4 }}>
            メンバーの一覧・マップ・移動指示は「配置」タブに集約
          </div>
          {/* AI配置提案は「配置」タブへ移しました（2026-08-13）。配信の入口を1箇所に集約するため、
              このコンソールからは提案パネルを呼ばない（ProposalPanelは components/board/proposal-panel.tsx） */}
          <div style={{ fontSize: 13, color: DAY.textFaint, marginBottom: 8 }}>
            AI配置提案は「配置」タブへ移しました
          </div>
          <button
            onClick={onOpenBoard}
            style={{
              width: "100%",
              minHeight: 44,
              borderRadius: 9,
              border: "none",
              background: DAY.text,
              color: "#FFF",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            配置タブを開く
          </button>
        </section>
      </div>

      {/* ── 5. 退場シミュレーション（人流モデル・決定的） ── */}
      <EgressPanel tickets={scenario.tickets} />
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
