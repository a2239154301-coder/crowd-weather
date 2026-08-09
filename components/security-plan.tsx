"use client";

import type { DayPlan, Scenario } from "@/lib/forecast/types";
import { zonesFor } from "@/lib/forecast/venue";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import VenueMap, { type StaffMark } from "./venue-map";

/**
 * 雑踏警備計画書（自動生成・抜粋）。
 *
 * この製品の出口は予測値ではなく「人が読み、警察に説明し、承認を得る文書」である、
 * というのが AIである必然性 の主張。ここはその文書の姿を先に確定させるための画面。
 * PDF出力は優先02で実装する。
 */

const WEATHER_LABEL: Record<Scenario["weather"], string> = {
  sunny: "晴",
  cloudy: "曇",
  rainy: "雨",
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
  const ops = [
    `給水スタッフ +${plan.water}`,
    `救護スタッフ +${plan.aid}`,
    `誘導スタッフ +${plan.guide}`,
    plan.mist ? "ミスト稼働" : null,
    plan.oneway ? "南通路 一方通行化" : null,
    plan.entryControl ? "入退場制限の準備" : null,
    plan.stationCoord ? "鉄道事業者・警察と退場時連携" : null,
  ].filter(Boolean) as string[];

  const rows: [string, string][] = [
    [
      "予報シナリオ",
      `${WEATHER_LABEL[scenario.weather]}・${scenario.temp}℃ ／ 来場規模 ${scenario.tickets.toLocaleString()}`,
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

  return (
    <section
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
      </header>

      <div className="cw-plan" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 22, marginTop: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
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

        <figure style={{ margin: 0 }}>
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
      </div>

      <p style={{ marginTop: 16, marginBottom: 0, fontSize: 11.5, color: INK.textFaint, lineHeight: 1.75 }}>
        時間帯別シフト表とPDF出力に対応予定（本デモは抜粋）。会場ごとの実績を学習し、
        2会場目以降の初期設定コストを下げる。
      </p>
    </section>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
