"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Scenario, Zone } from "@/lib/forecast/types";
import { HOURS, VENUE } from "@/lib/forecast/venue";
import { hourPeak } from "@/lib/forecast/model";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";

/**
 * 時間帯別予報ストリップ（馬場v4の Hourly Forecast を移植・復活）。
 *
 * 統合時にこの棒グラフが落ちていた。予報プロダクトの一番の主張が
 * 「一日の形が先に見える」ことなので、画面の最初に置く。
 * 1時間＝1枚のカード。混雑（左）と暑熱（右）を並べた2本の棒で、
 * 山がどこにあるかを数字を読まずに掴めるようにしている。
 * クリックでその時刻へ移動し、会場図・スタッツすべてが追従する。
 */

const WEATHER_GLYPH: Record<Scenario["weather"], string> = { sunny: "☀", cloudy: "☁", rainy: "☂" };

type Props = {
  zones: Zone[];
  scenario: Scenario;
  hour: number;
  onHourChange: (h: number) => void;
  scopeLabel: string;
};

const STEP_MS = 750;

export default function HourlyStrip({ zones, scenario, hour, onHourChange, scopeLabel }: Props) {
  const peaks = useMemo(
    () => HOURS.map((h) => ({ h, ...hourPeak(zones, h, scenario) })),
    [zones, scenario]
  );

  // 「一日を再生」: 開場から終演までを自動送りし、会場図・スタッツを全部動かす。
  // 「今を見る」ダッシュボードと「先を読む」予報の差が、1操作で伝わる部分。
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hourRef = useRef(hour);
  hourRef.current = hour;

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      onHourChange(hourRef.current >= VENUE.close ? VENUE.open : hourRef.current + 1);
    }, STEP_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, onHourChange]);

  const togglePlay = () => {
    if (!playing && hourRef.current >= VENUE.close) onHourChange(VENUE.open);
    setPlaying((p) => !p);
  };

  return (
    <section
      style={{
        background: INK.surface,
        border: `1px solid ${INK.line}`,
        borderRadius: 14,
        padding: 16,
      }}
      aria-label="時間帯別予報"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <div className="cw-mono" style={{ fontSize: 11, letterSpacing: 1.5, color: INK.textFaint }}>
            HOURLY FORECAST ── 時間帯別予報
          </div>
          <div style={{ fontWeight: 600, fontSize: 15, marginTop: 3 }}>
            「今を見る」から「先を読む」へ
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={togglePlay}
            aria-pressed={playing}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
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
          <span className="cw-mono" style={{ fontSize: 11, color: INK.textFaint }}>
            クリックで会場図に反映 ↓
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {peaks.map((p) => {
          const ds = densityBand(p.maxDensity);
          const hs = wbgtBand(p.maxWbgt);
          const active = p.h === hour;
          return (
            <button
              key={p.h}
              onClick={() => onHourChange(p.h)}
              aria-current={active ? "true" : undefined}
              title={`${p.h}:00 ／ 混雑 ${p.maxDensity}（${p.maxDensityZone.name}） ／ WBGT ${p.maxWbgt}`}
              style={{
                flex: "0 0 auto",
                width: 78,
                background: active ? INK.raised : "transparent",
                border: `1px solid ${active ? INK.accent : INK.line}`,
                borderRadius: 12,
                padding: "10px 6px",
                cursor: "pointer",
                color: INK.text,
                textAlign: "center",
                transition: "border-color 150ms ease, background 150ms ease",
              }}
            >
              <div className="cw-mono" style={{ fontSize: 13, color: active ? INK.accent : INK.textDim }}>
                {p.h}:00
              </div>
              <div style={{ margin: "6px 0", fontSize: 15, color: INK.textDim }}>
                {WEATHER_GLYPH[scenario.weather]}
              </div>
              <div style={{ height: 44, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 5 }}>
                <span
                  title="混雑指数"
                  style={{
                    width: 12,
                    height: `${Math.max(6, p.maxDensity * 0.42)}px`,
                    background: ds.color,
                    borderRadius: 3,
                    transition: "height 320ms ease",
                  }}
                />
                <span
                  title="暑熱指数(WBGT)"
                  style={{
                    width: 12,
                    // WBGT 20℃を床にして見た目の差を出す（v4の描き方を踏襲）
                    height: `${Math.max(6, (p.maxWbgt - 20) * 3.4)}px`,
                    background: hs.color,
                    borderRadius: 3,
                    opacity: 0.85,
                    transition: "height 320ms ease",
                  }}
                />
              </div>
              <div className="cw-mono" style={{ fontSize: 11, marginTop: 5, color: ds.color }}>
                {p.maxDensity}
              </div>
            </button>
          );
        })}
      </div>

      <div
        className="cw-mono"
        style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 10, color: INK.textFaint, flexWrap: "wrap" }}
      >
        <LegendKey color="#FB7A1E" label="混雑指数" />
        <LegendKey color="#EF4444" label="暑熱指数(WBGT)" />
        <span>※ 表示中スコープ（{scopeLabel}）の最大値</span>
      </div>
    </section>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <i style={{ width: 9, height: 9, background: color, borderRadius: 2, display: "inline-block" }} />
      {label}
    </span>
  );
}
