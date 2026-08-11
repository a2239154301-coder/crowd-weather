"use client";

import { useRef, useState } from "react";
import type { DayPlan, Scenario } from "@/lib/forecast/types";
import { zonesFor } from "@/lib/forecast/venue";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import VenueMap, { type StaffMark } from "./venue-map";

/**
 * 雑踏警備計画書（自動生成・抜粋）。
 *
 * この製品の出口は予測値ではなく「人が読み、警察に説明し、承認を得る文書」である、
 * というのが AIである必然性 の主張。
 *
 * 2026-08-11（馬場氏要望4 ≒ 優先02の前倒し）:
 * - 配置図（混雑ピーク）に加えて暑熱・日陰図（暑熱ピーク）を併載
 * - 総括文をAIが起草（plan タスク・上位モデル。数値は全て計算エンジンの出力）
 * - 「印刷 / PDF保存」— ブラウザの印刷機能で手元にファイルが残る
 *   （専用PDF生成システムはハッカソンでは作らない、という割り切り）
 */

const WEATHER_LABEL: Record<Scenario["weather"], string> = {
  sunny: "晴",
  cloudy: "曇",
  rainy: "雨",
};

type PlanMeta = {
  servedModel: string;
  fallbackLevel: number;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
};

export default function SecurityPlan({
  scenario,
  plan,
  staff,
}: {
  scenario: Scenario;
  plan: DayPlan;
  staff: StaffMark[];
}) {
  const [summary, setSummary] = useState("");
  const [summaryMeta, setSummaryMeta] = useState<(PlanMeta & { latencyMs: number }) | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const ops = [
    `給水スタッフ +${plan.water}`,
    `救護スタッフ +${plan.aid}`,
    `誘導スタッフ +${plan.guide}`,
    plan.tents.total > 0 ? `日よけテント ${plan.tents.total}張` : null,
    plan.mist ? "ミスト稼働" : null,
    plan.oneway ? "南通路 一方通行化" : null,
    plan.entryControl ? "入退場制限の準備" : null,
    plan.stationCoord ? "鉄道事業者・警察と退場時連携" : null,
  ].filter(Boolean) as string[];

  const rows: [string, string][] = [
    [
      "予報シナリオ",
      `${scenario.date.label} ${WEATHER_LABEL[scenario.weather]}・${scenario.temp}℃・湿度${scenario.rhPct}%・風${scenario.windMs.toFixed(1)}m/s ／ 来場規模 ${scenario.tickets.toLocaleString()}`,
    ],
    [
      "最大混雑",
      `混雑指数 ${plan.peakDensity}（${plan.peakDensityHour}:00 ${plan.peakDensityZone.name}）／ 待機列 約${plan.waitMin}分`,
    ],
    [
      "暑熱リスク",
      `WBGT ${plan.peakWbgt}（${wbgtBand(plan.peakWbgt).label}）／ ${plan.peakWbgtHour}:00 前後がピーク`,
    ],
    ["推奨配置", ops.join(" ／ ")],
    [
      "会場外",
      plan.outsideDanger
        ? "終演後、商店街の路地と駅ホームが危険密度。整列退場と時差退場アナウンスを実施する。"
        : "駅動線は許容範囲。通常巡回とする。",
    ],
    [
      "特記事項",
      plan.corridorDanger
        ? "退場動線が危険密度に達する。入退場制限と整列退場を準備する。"
        : "現配置で許容範囲。ピーク時間帯の巡回を強化する。",
    ],
  ];

  async function draftSummary() {
    setSummaryBusy(true);
    setSummary("");
    setSummaryMeta(null);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario: {
            date: scenario.date.label,
            weather: WEATHER_LABEL[scenario.weather],
            temp: scenario.temp,
            humidity: scenario.rhPct,
            windMs: scenario.windMs,
            tickets: scenario.tickets,
          },
          plan: {
            peakCrowd: plan.peakDensity,
            peakCrowdHour: plan.peakDensityHour,
            peakCrowdZone: plan.peakDensityZone.name,
            peakWBGT: plan.peakWbgt,
            peakWBGTHour: plan.peakWbgtHour,
            peakWBGTZone: plan.peakWbgtZone.name,
            staffing: { water: plan.water, aid: plan.aid, guide: plan.guide },
            tents: plan.tents,
            operations: ops,
            outsideDanger: plan.outsideDanger,
            corridorDanger: plan.corridorDanger,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      setSummary(data.text || "");
      setSummaryMeta({ ...(data.meta as PlanMeta), latencyMs: Date.now() - t0 });
    } catch {
      setSummary("総括の起草に失敗しました。もう一度お試しください。");
    } finally {
      setSummaryBusy(false);
    }
  }

  /**
   * 印刷 / PDF保存。画面はダークだが文書は白紙に出す。
   * 計画書セクションのHTMLを複製し、印刷向けの明色スタイルを被せた別窓で window.print()。
   * SVGの会場図はそのまま複製する（図版として自己完結しているため暗色のままで読める）。
   */
  function printPlan() {
    const node = printRef.current;
    if (!node) return;
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return;
    w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>雑踏警備計画書（抜粋）｜CROWD WEATHER</title>
<style>
  body { font-family: "Yu Gothic", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
         color: #111; margin: 28px; line-height: 1.8; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #555; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 18px; }
  th { text-align: left; vertical-align: top; padding: 8px 12px 8px 0; color: #555;
       font-weight: 600; white-space: nowrap; width: 90px; border-top: 1px solid #ddd; }
  td { padding: 8px 0; border-top: 1px solid #ddd; }
  .maps { display: flex; gap: 14px; }
  .maps figure { margin: 0; flex: 1; }
  .maps figcaption { font-size: 10.5px; color: #555; margin-bottom: 5px; }
  .maps svg { width: 100%; height: auto; border-radius: 6px; }
  .summary { border: 1px solid #ccc; border-radius: 8px; padding: 12px 14px;
             font-size: 12.5px; white-space: pre-wrap; margin-bottom: 16px; }
  .foot { font-size: 10px; color: #777; margin-top: 18px;
          border-top: 1px solid #ddd; padding-top: 8px; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<h1>雑踏警備計画書（自動生成・抜粋）</h1>
<div class="sub">CROWD WEATHER ｜ 発行 ${new Date().toLocaleString("ja-JP")} ｜ DRAFT — 責任者の確認・承認が必要です</div>
${summary ? `<div class="summary"><b>総括</b>\n${summary.replace(/</g, "&lt;")}</div>` : ""}
${tableHtml(rows)}
<div class="maps">${mapsHtml(node)}</div>
<div class="foot">予測は CROWD WEATHER の決定的計算エンジン（混雑指数・NOAA太陽位置・WBGT物理式）による。
総括文はAI起草${summaryMeta ? `（${summaryMeta.servedModel}）` : ""}・数値はすべて計算エンジンの出力値。DEMO DATA — 実在会場の実配置ではありません。</div>
<script>window.onload = () => window.print();</script>
</body></html>`);
    w.document.close();
  }

  return (
    <section
      ref={printRef}
      style={{
        background: INK.surface,
        border: `1px solid ${INK.line}`,
        borderRadius: 14,
        padding: 20,
      }}
      aria-label="雑踏警備計画書"
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          paddingBottom: 12,
          borderBottom: `1px solid ${INK.line}`,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>雑踏警備計画書（自動生成・抜粋）</h2>
          <div style={{ fontSize: 11.5, color: INK.textFaint, marginTop: 3 }}>
            警察への事前協議・社内稟議で用いる法定文書のフォーマットに準拠
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={draftSummary}
            disabled={summaryBusy}
            style={{
              padding: "8px 15px",
              borderRadius: 999,
              border: `1px solid ${INK.accent}`,
              background: "transparent",
              color: summaryBusy ? INK.textFaint : INK.accent,
              fontWeight: 700,
              fontSize: 12,
              cursor: summaryBusy ? "wait" : "pointer",
            }}
          >
            {summaryBusy ? "起草中…" : "総括をAIが起草"}
          </button>
          <button
            onClick={printPlan}
            style={{
              padding: "8px 15px",
              borderRadius: 999,
              border: "none",
              background: INK.text,
              color: INK.page,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            印刷 / PDF保存
          </button>
          <span
            className="cw-mono"
            style={{
              fontSize: 11,
              color: INK.textFaint,
              border: `1px solid ${INK.line}`,
              borderRadius: 999,
              padding: "4px 11px",
            }}
          >
            DRAFT
          </span>
        </div>
      </header>

      {summary && (
        <div
          style={{
            marginTop: 14,
            background: INK.raised,
            border: `1px solid ${INK.line}`,
            borderRadius: 10,
            padding: "13px 15px",
            fontSize: 13,
            lineHeight: 1.9,
            whiteSpace: "pre-wrap",
          }}
        >
          <div className="cw-mono" style={{ fontSize: 10.5, color: INK.textFaint, marginBottom: 7 }}>
            総括（AI起草・要確認）
            {summaryMeta &&
              ` ── ${summaryMeta.servedModel} ／ ${(summaryMeta.latencyMs / 1000).toFixed(1)}s${summaryMeta.usage ? ` ／ out ${summaryMeta.usage.completion_tokens}tok` : ""}`}
          </div>
          {summary}
        </div>
      )}

      <div className="cw-plan" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 22, marginTop: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} data-plan-table>
          <tbody>
            {rows.map(([k, v], i) => (
              <tr key={k} style={{ borderTop: i ? `1px solid ${INK.hairline}` : "none" }}>
                <th
                  scope="row"
                  style={{
                    textAlign: "left",
                    verticalAlign: "top",
                    padding: "10px 12px 10px 0",
                    color: INK.textFaint,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    width: 84,
                  }}
                >
                  {k}
                </th>
                <td style={{ padding: "10px 0", color: INK.text, lineHeight: 1.75 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "grid", gap: 14 }}>
          <figure style={{ margin: 0 }} data-plan-map="crowd">
            <figcaption style={{ fontSize: 11.5, color: INK.textFaint, marginBottom: 7 }}>
              配置図（混雑ピーク {plan.peakDensityHour}:00 時点・自動生成）
            </figcaption>
            <VenueMap
              zones={zonesFor("in")}
              hour={plan.peakDensityHour}
              scenario={scenario}
              layer="crowd"
              staff={staff}
              compact
            />
            <div style={{ display: "flex", gap: 14, marginTop: 9, fontSize: 11.5, color: INK.textDim }}>
              <LegendDot color="#38BDF8" label="給水" />
              <LegendDot color="#FDE047" label="誘導" />
              <LegendDot color="#22C55E" label="救護" />
              <span style={{ marginLeft: "auto", color: INK.textFaint }}>
                最混雑 {densityBand(plan.peakDensity).label}
              </span>
            </div>
          </figure>

          <figure style={{ margin: 0 }} data-plan-map="heat">
            <figcaption style={{ fontSize: 11.5, color: INK.textFaint, marginBottom: 7 }}>
              暑熱・日陰図（暑熱ピーク {plan.peakWbgtHour}:00 時点・WBGT物理計算）
            </figcaption>
            <VenueMap
              zones={zonesFor("in")}
              hour={plan.peakWbgtHour}
              scenario={scenario}
              layer="heat"
              compact
            />
          </figure>
        </div>
      </div>

      <p style={{ marginTop: 16, marginBottom: 0, fontSize: 11.5, color: INK.textFaint, lineHeight: 1.75 }}>
        「印刷 / PDF保存」で手元にファイルが残る（ブラウザの印刷機能を使用）。
        会場ごとの実績を学習し、2会場目以降の初期設定コストを下げる。
      </p>
    </section>
  );
}

/** 印刷用: 計画表のHTMLを組み立てる（画面のstateから直接） */
function tableHtml(rows: [string, string][]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<table>${rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

/** 印刷用: 画面に描画済みの会場図SVGを複製する */
function mapsHtml(root: HTMLElement): string {
  const out: string[] = [];
  root.querySelectorAll("[data-plan-map]").forEach((fig) => {
    const svg = fig.querySelector("svg");
    const caption = fig.querySelector("figcaption")?.textContent ?? "";
    if (svg) {
      out.push(`<figure><figcaption>${caption}</figcaption>${svg.outerHTML}</figure>`);
    }
  });
  return out.join("");
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
