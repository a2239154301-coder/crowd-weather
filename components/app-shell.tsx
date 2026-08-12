"use client";

import { useMemo, useState } from "react";
import { INK } from "@/lib/forecast/scales";
import type { Scenario } from "@/lib/forecast/types";
import { DEFAULT_SCENARIO } from "@/lib/forecast/venue";
import OpsConsole from "./ops-console";
import IngestPanel from "./ingest-panel";
import VisitorRoute from "./visitor-route";
import LiveConsole from "./live-console";
import AdjustConsole from "./adjust-console";
import StaffConsole from "./staff-console";
import PlanOutput from "./plan-output";
import { ScenarioProvider } from "@/lib/ui/scenario-context";
import CompareBar from "./compare-bar";
import TrustPanel from "./trust-panel";
import { VisitorApp, DataView } from "./crowd-weather";
import { dayPlan } from "@/lib/forecast/model";

/**
 * 画面の骨格。2026-08-11 に情報設計を再編（馬場氏要望1）:
 *
 * 従来はフラットな4タブで「誰のための画面か」が読めなかった。
 * 最上位を **使う人** で分け、主催者側は
 * 「読み込む → 条件 → 予報 → 出力」の作業手順をステッパーで示す。
 * 番号は飾りではなく実際の作業順序（このワークフロー自体が製品の主張）。
 *
 * 2026-08-12、最上位を **フェーズ**（準備／当日／来場者）に割り直した。
 * 従来は「準備フェーズ」だけに最適化されていて、いちばん価値が高い
 * 当日の画面が存在しなかった。予報プロダクトの本番は当日の炎天下の現場であって、
 * 事務所のPCではない。
 */

type Mode = "plan" | "live" | "staff" | "visitor";
type OrganizerView = "ops" | "output" | "ingest" | "data" | "trust";
type LiveView = "status" | "adjust";

const ORGANIZER_TABS: [OrganizerView, string][] = [
  ["ops", "予報コンソール"],
  ["output", "計画書出力"],
  ["ingest", "会場を読み込む"],
  ["data", "データ設計"],
  ["trust", "コストと安全"],
];

/** 作業手順。step→タブの対応があるものはクリックで遷移できる */
const STEPS: { n: number; label: string; hint: string; goto?: OrganizerView }[] = [
  { n: 1, label: "会場を読み込む", hint: "写真から初期モデルを生成", goto: "ingest" },
  { n: 2, label: "条件を設定", hint: "実況の取込み or 手動入力", goto: "ops" },
  { n: 3, label: "予報を確認", hint: "混雑・暑熱・日陰・What-if", goto: "ops" },
  { n: 4, label: "出力する", hint: "指示書・計画書・ブリーフィング", goto: "ops" },
];

export default function AppShell() {
  const [mode, setMode] = useState<Mode>("plan");
  const [view, setView] = useState<OrganizerView>("ops");
  const [liveView, setLiveView] = useState<LiveView>("status");

  // 来場者アプリは移植前のモックのまま。新しい予報モデルの結果を、
  // 旧モックが期待する項目名にも詰め替えて渡す。
  const [legacyHour, setLegacyHour] = useState(16);
  const legacyScenario: Scenario = DEFAULT_SCENARIO;
  const legacyPlan = useMemo(() => {
    const p = dayPlan(legacyScenario);
    return {
      ...p,
      peakD: p.peakDensity,
      peakDH: p.peakDensityHour,
      peakDZ: p.peakDensityZone,
      peakW: p.peakWbgt,
      peakWH: p.peakWbgtHour,
    };
    // legacyScenario は固定値なので依存配列は空でよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScenarioProvider>
    <div style={{ minHeight: "100vh", background: INK.page, color: INK.text }}>
      <style>{`
        @media (max-width: 900px) {
          .cw-split { grid-template-columns: 1fr !important; }
          .cw-plan  { grid-template-columns: 1fr !important; }
          .cw-steps { display: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: 1360, margin: "0 auto", padding: "20px 18px 72px" }}>
        <CompareBar />
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: 2 }}>
                CROWD WEATHER
              </h1>
              <span style={{ fontSize: 12.5, color: INK.textDim }}>混雑は、予報できる。</span>
            </div>
          </div>

          {/* 最上位: 誰のための画面か */}
          <div
            role="tablist"
            aria-label="フェーズの切り替え"
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 3,
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 11,
              padding: 3,
            }}
          >
            {(
              [
                ["plan", "計画する", "会場を作り、条件を振り、計画書を出す"],
                ["live", "当日を回す", "状況の確認と、計画の調整"],
                ["staff", "スタッフ", "指示を受け、状況を報告する"],
                ["visitor", "来場者", "スマホで見る安全情報"],
              ] as [Mode, string, string][]
            ).map(([k, label, hint]) => (
              <button
                key={k}
                role="tab"
                aria-selected={mode === k}
                onClick={() => setMode(k)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 1,
                  padding: "8px 16px",
                  borderRadius: 9,
                  border: "none",
                  cursor: "pointer",
                  background: mode === k ? INK.text : "transparent",
                  color: mode === k ? INK.page : INK.textDim,
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</span>
                <span style={{ fontSize: 10, opacity: 0.75 }}>{hint}</span>
              </button>
            ))}
          </div>
        </header>

        {mode === "plan" && (
          <>
            {/* 作業手順ステッパー + サブタブ */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 14,
              }}
            >
              <nav
                aria-label="主催者メニュー"
                style={{
                  display: "flex",
                  gap: 3,
                  background: INK.surface,
                  border: `1px solid ${INK.line}`,
                  borderRadius: 10,
                  padding: 3,
                }}
              >
                {ORGANIZER_TABS.map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setView(k)}
                    aria-current={view === k ? "page" : undefined}
                    style={{
                      padding: "8px 15px",
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 12.5,
                      fontWeight: 600,
                      background: view === k ? INK.raised : "transparent",
                      color: view === k ? INK.text : INK.textDim,
                      boxShadow: view === k ? `inset 0 0 0 1px ${INK.line}` : "none",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>

              <ol
                className="cw-steps"
                style={{
                  listStyle: "none",
                  margin: 0,
                  marginLeft: "auto",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 0,
                }}
              >
                {STEPS.map((s, i) => (
                  <li key={s.n} style={{ display: "flex", alignItems: "center" }}>
                    {i > 0 && (
                      <span style={{ color: INK.textFaint, fontSize: 11, padding: "0 7px" }}>→</span>
                    )}
                    <button
                      onClick={() => s.goto && setView(s.goto)}
                      title={s.hint}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 5,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: "2px 3px",
                        color:
                          (s.n === 1 && view === "ingest") || (s.n > 1 && view === "ops")
                            ? INK.text
                            : INK.textDim,
                      }}
                    >
                      <span
                        className="cw-mono"
                        style={{
                          fontSize: 10,
                          border: `1px solid ${INK.line}`,
                          borderRadius: 999,
                          width: 16,
                          height: 16,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {s.n}
                      </span>
                      <span style={{ fontSize: 11.5, fontWeight: 600 }}>{s.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>

            {view === "ops" && <OpsConsole />}
            {view === "output" && <PlanOutput />}
            {view === "ingest" && <IngestPanel />}
            {view === "data" && <DataView />}
            {view === "trust" && <TrustPanel />}
          </>
        )}

        {mode === "live" && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
              <nav
                aria-label="当日メニュー"
                style={{
                  display: "flex",
                  gap: 3,
                  background: INK.surface,
                  border: `1px solid ${INK.line}`,
                  borderRadius: 10,
                  padding: 3,
                }}
              >
                {(
                  [
                    ["status", "状況 — いまどこが危ないか"],
                    ["adjust", "調整 — 計画と実際を合わせる"],
                  ] as [LiveView, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setLiveView(k)}
                    aria-current={liveView === k ? "page" : undefined}
                    style={{
                      minHeight: 44,
                      padding: "0 15px",
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 12.5,
                      fontWeight: 600,
                      background: liveView === k ? INK.raised : "transparent",
                      color: liveView === k ? INK.text : INK.textDim,
                      boxShadow: liveView === k ? `inset 0 0 0 1px ${INK.line}` : "none",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <span style={{ fontSize: 12, color: INK.textFaint }}>
                屋外・スマホ前提のため当日系の画面は明色
              </span>
            </div>
            {liveView === "status" && <LiveConsole />}
            {liveView === "adjust" && <AdjustConsole />}
          </>
        )}

        {mode === "staff" && (
          <>
            <p style={{ margin: "0 0 14px", fontSize: 12.5, color: INK.textDim, lineHeight: 1.8 }}>
              現場スタッフのスマホ画面。名前で入場し、配置ポストの指示を受け、
              現地の混雑・暑さをワンタップで報告する。
            </p>
            <StaffConsole />
          </>
        )}

        {mode === "visitor" && (
          <>
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 12.5,
                color: INK.textDim,
                lineHeight: 1.8,
              }}
            >
              来場者のスマホに届く画面。どこが空いていて、どこが日陰で、救護がどこにあるか —
              これまでスタッフに聞かないと分からなかった情報を手元に。
            </p>
            <div style={{ display: "grid", gap: 16 }}>
              <VisitorRoute scenario={legacyScenario} hour={legacyHour} />
              <VisitorApp
                s={legacyScenario}
                hour={legacyHour}
                setHour={setLegacyHour}
                plan={legacyPlan}
              />
            </div>
          </>
        )}

        <footer
          style={{
            marginTop: 26,
            paddingTop: 14,
            borderTop: `1px solid ${INK.hairline}`,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 11.5,
            color: INK.textFaint,
          }}
        >
          <span>事故ゼロと、最高の体験は、両立できる。</span>
          <span>CROWD WEATHER ｜ AI HACK 2026 ｜ powered by OrcaRouter</span>
        </footer>
      </div>
    </div>
    </ScenarioProvider>
  );
}
