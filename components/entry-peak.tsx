"use client";

import { useMemo } from "react";
import { simulateIngress } from "@/lib/forecast/ingress";
import { INK } from "@/lib/forecast/scales";
import { DAY } from "@/lib/ui/day-theme";
import SourceTag from "./source-tag";

/**
 * 「入場が混む時間帯」パネル。
 *
 * simulateIngress()（lib/forecast/ingress.ts・LLM不使用の決定的計算）の結果を
 * そのまま見せる。準備モード（ops-console）は暗色 INK、当日モード（live-console）
 * は明色 DAY を tone で切り替える（source-tag.tsx と同じ規約）。
 */
export default function EntryPeak({ tickets, tone }: { tickets: number; tone: "ink" | "day" }) {
  const result = useMemo(() => simulateIngress(tickets), [tickets]);
  const { peakHour, maxWaitMin, maxWaitGate, maxWaitHour, assumptions, byGate } = result;

  const t = tone === "ink" ? INK : DAY;
  const barColor = tone === "ink" ? INK.line : DAY.line;
  const peakColor = tone === "ink" ? INK.accent : DAY.text;

  const hours = byGate.west.map((row) => row.hour);
  const totalByHour = hours.map((h, i) => byGate.west[i].arrivals + byGate.east[i].arrivals);
  const maxArrival = Math.max(1, ...totalByHour);

  const gateLabel = maxWaitGate === "west" ? "西" : "東";
  const waitIntMin = Math.floor(maxWaitMin); // 「0捨て」＝小数を切り捨てて整数にする
  const summary =
    maxWaitMin < 5
      ? `${peakHour}:00台がピーク・待ちはほぼ発生しない見込み`
      : `${peakHour}:00台がピーク・最大待ち 約${waitIntMin}分（${gateLabel}ゲート・${maxWaitHour}:00台）`;

  // ── バーチャート寸法（SVG viewBox。DayCurve/HourlyStrip と同じ相対配置の考え方） ──
  const W = 620;
  const H = 116;
  const padL = 6;
  const padR = 6;
  const padB = 18;
  const barGap = 6;
  const chartH = H - padB - 4;
  const barW = (W - padL - padR - barGap * (hours.length - 1)) / hours.length;
  const barX = (i: number) => padL + i * (barW + barGap);
  const barH = (v: number) => (v / maxArrival) * chartH;

  return (
    <section
      style={{
        background: t.surface,
        border: `1px solid ${t.line}`,
        borderRadius: 14,
        padding: 16,
      }}
      aria-label="入場が混む時間帯"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: t.text }}>入場が混む時間帯</div>
        <SourceTag kind="calc" tone={tone} />
      </div>

      <div style={{ marginTop: 10, fontSize: 15, fontWeight: 700, color: t.text, lineHeight: 1.5 }}>
        {summary}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block", marginTop: 12 }}
        role="img"
        aria-label="時間帯別の入場者到着人数（全ゲート合計）"
      >
        {hours.map((h, i) => {
          const v = totalByHour[i];
          const isPeak = h === peakHour;
          const height = v > 0 ? Math.max(2, barH(v)) : 0;
          return (
            <g key={h}>
              <rect
                x={barX(i)}
                y={chartH - height + 4}
                width={barW}
                height={height}
                rx={2}
                fill={isPeak ? peakColor : barColor}
              />
              <text x={barX(i) + barW / 2} y={H - 4} textAnchor="middle" fontSize={13} fill={t.textFaint}>
                {h}
              </text>
            </g>
          );
        })}
      </svg>

      <div style={{ marginTop: 10, fontSize: 13, color: t.textFaint, lineHeight: 1.6 }}>
        レーン{assumptions.lanesPerGate}×{assumptions.personsPerLaneMin}人/分/ゲートの想定値（デモデータ）。
        チケット{tickets.toLocaleString()}枚・在場率カーブの時間差分から算出
      </div>
    </section>
  );
}
