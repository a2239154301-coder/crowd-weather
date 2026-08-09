"use client";

import { useEffect, useRef, useState } from "react";
import type { Scenario, Zone } from "@/lib/forecast/types";
import { HOURS, VENUE } from "@/lib/forecast/venue";
import { hourPeak } from "@/lib/forecast/model";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";

/**
 * 予報タイムライン。この画面の signature。
 *
 * 「▶ 一日を再生」を押すと開場から終演までが動く。日陰が東から西へ滑り、
 * ステージに混雑が湧き、開場と終演でゲートが赤く弾ける。
 * ダッシュボード（今を見る）と予報（先を読む）の差が、1つの操作で伝わる。
 *
 * 混雑と暑熱は単位が違うので、1つのグラフに2軸で重ねず**行を分ける**（small multiples）。
 */

const STEP_MS = 750;
const ROW_H = 34;

type Props = {
  zones: Zone[];
  scenario: Scenario;
  hour: number;
  onHourChange: (h: number) => void;
};

export default function ForecastTimeline({ zones, scenario, hour, onHourChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hourRef = useRef(hour);
  hourRef.current = hour;

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      const next = hourRef.current >= VENUE.close ? VENUE.open : hourRef.current + 1;
      onHourChange(next);
    }, STEP_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, onHourChange]);

  const peaks = HOURS.map((h) => hourPeak(zones, h, scenario));
  const maxD = Math.max(...peaks.map((p) => p.maxDensity), 1);
  const wLo = Math.min(...peaks.map((p) => p.maxWbgt));
  const wHi = Math.max(...peaks.map((p) => p.maxWbgt));
  const wSpan = Math.max(wHi - wLo, 1);

  const play = () => {
    if (!playing && hourRef.current >= VENUE.close) onHourChange(VENUE.open);
    setPlaying((p) => !p);
  };

  return (
    <section
      style={{
        background: INK.surface,
        border: `1px solid ${INK.line}`,
        borderRadius: 14,
        padding: "14px 16px 10px",
      }}
      aria-label="時間帯別予報"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        <button
          onClick={play}
          aria-pressed={playing}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "9px 17px 9px 14px",
            borderRadius: 999,
            border: `1px solid ${playing ? INK.accent : INK.line}`,
            background: playing ? INK.accent : "transparent",
            color: playing ? INK.page : INK.text,
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          <span aria-hidden style={{ fontSize: 11 }}>{playing ? "■" : "▶"}</span>
          {playing ? "停止" : "一日を再生"}
        </button>
        <div style={{ fontSize: 12.5, color: INK.textDim }}>
          「今を見る」から<span style={{ color: INK.text, fontWeight: 600 }}>「先を読む」</span>へ
        </div>
        <div className="cw-mono" style={{ marginLeft: "auto", fontSize: 11, color: INK.textFaint }}>
          開場 {VENUE.open}:00 — 終演 {VENUE.close}:00
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "58px 1fr", gap: "0 10px", alignItems: "center" }}>
        <RowLabel text="混雑" />
        <BarRow
          values={peaks.map((p) => p.maxDensity)}
          colors={peaks.map((p) => densityBand(p.maxDensity).color)}
          norm={(v) => v / maxD}
          hour={hour}
          onPick={onHourChange}
          format={(v) => `${v}`}
        />

        <RowLabel text="暑熱" />
        <BarRow
          values={peaks.map((p) => p.maxWbgt)}
          colors={peaks.map((p) => wbgtBand(p.maxWbgt).color)}
          norm={(v) => 0.22 + (0.78 * (v - wLo)) / wSpan}
          hour={hour}
          onPick={onHourChange}
          format={(v) => v.toFixed(1)}
        />

        <div />
        <div style={{ display: "flex", gap: 3 }}>
          {HOURS.map((h) => (
            <div
              key={h}
              className="cw-mono"
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 11,
                paddingTop: 5,
                color: h === hour ? INK.accent : INK.textFaint,
                fontWeight: h === hour ? 700 : 400,
              }}
            >
              {h}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function RowLabel({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 12, color: INK.textDim, textAlign: "right", paddingRight: 2 }}>{text}</div>
  );
}

function BarRow({
  values,
  colors,
  norm,
  hour,
  onPick,
  format,
}: {
  values: number[];
  colors: string[];
  norm: (v: number) => number;
  hour: number;
  onPick: (h: number) => void;
  format: (v: number) => string;
}) {
  const peakIndex = values.indexOf(Math.max(...values));
  return (
    <div style={{ display: "flex", gap: 3, height: ROW_H, alignItems: "flex-end" }}>
      {values.map((v, i) => {
        const h = HOURS[i];
        const isNow = h === hour;
        return (
          <button
            key={h}
            onClick={() => onPick(h)}
            title={`${h}:00 ／ ${format(v)}`}
            aria-label={`${h}時 ${format(v)}`}
            style={{
              flex: 1,
              height: "100%",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              background: isNow ? "rgba(125,211,252,0.10)" : "transparent",
              border: "none",
              borderRadius: 4,
              padding: 0,
              cursor: "pointer",
              position: "relative",
            }}
          >
            <span
              style={{
                display: "block",
                width: "100%",
                height: `${Math.max(8, norm(v) * ROW_H)}px`,
                background: colors[i],
                opacity: isNow ? 1 : 0.72,
                borderRadius: "4px 4px 0 0",
                transition: "height 320ms ease, opacity 160ms ease",
              }}
            />
            {i === peakIndex && (
              <span
                className="cw-mono"
                style={{
                  position: "absolute",
                  top: -3,
                  fontSize: 10,
                  color: INK.text,
                  textShadow: `0 0 5px ${INK.page}`,
                  pointerEvents: "none",
                }}
              >
                {format(v)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
