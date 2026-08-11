"use client";

import { useMemo, useState } from "react";
import { INK } from "@/lib/forecast/scales";
import type { Scenario } from "@/lib/forecast/types";
import { DEFAULT_SCENARIO } from "@/lib/forecast/venue";
import OpsConsole from "./ops-console";
import IngestPanel from "./ingest-panel";
import CompareBar from "./compare-bar";
import { VisitorApp, DataView } from "./crowd-weather";
import { dayPlan } from "@/lib/forecast/model";

type View = "ops" | "ingest" | "app" | "data";

const TABS: [View, string][] = [
  ["ops", "主催者コンソール"],
  ["ingest", "会場を読み込む"],
  ["app", "来場者アプリ"],
  ["data", "データ設計"],
];

export default function AppShell() {
  const [view, setView] = useState<View>("ops");

  // 来場者アプリ・データ設計タブは移植前のモックのまま。優先01以降で順次刷新する。
  // 新しい予報モデルの結果を、旧モックが期待する項目名にも詰め替えて渡す。
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
    <div style={{ minHeight: "100vh", background: INK.page, color: INK.text }}>
      <style>{`
        @media (max-width: 900px) {
          .cw-split { grid-template-columns: 1fr !important; }
          .cw-plan  { grid-template-columns: 1fr !important; }
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
            marginBottom: 16,
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

          <nav
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 3,
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 10,
              padding: 3,
            }}
          >
            {TABS.map(([k, label]) => (
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
                  background: view === k ? INK.text : "transparent",
                  color: view === k ? INK.page : INK.textDim,
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        {view === "ops" && <OpsConsole />}
        {view === "ingest" && <IngestPanel />}
        {view === "app" && (
          <VisitorApp
            s={legacyScenario}
            hour={legacyHour}
            setHour={setLegacyHour}
            plan={legacyPlan}
          />
        )}
        {view === "data" && <DataView />}

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
  );
}
