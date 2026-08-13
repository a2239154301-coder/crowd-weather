"use client";

import { useMemo } from "react";
import type { Scenario, Zone } from "@/lib/forecast/types";
import { VENUE } from "@/lib/forecast/venue";
import { forecastZones } from "@/lib/forecast/model";
import { INK, WBGT_BANDS, wbgtBand } from "@/lib/forecast/scales";

/**
 * ゾーン別 危険度タイムライン（馬場v4の Zone Timeline を移植・復活）。
 *
 * 「どこが、いつ、危険になるか」を1枚で見せる。
 * 行=ゾーン／列=時刻／セルの色=WBGT区分／セル下部の塗りの高さ=日陰率。
 *
 * 時間帯別ストリップ（会場全体の最大値）では潰れてしまう
 * 「特定のゾーンだけが昼過ぎに危険になる」という形が、ここで見える。
 * 30分刻みにすると横に溢れるため、1時間刻み＋クリックでその時刻へ。
 */

type Props = {
  zones: Zone[];
  scenario: Scenario;
  hour: number;
  onHourChange: (h: number) => void;
};

// タップ目標44pxルールの例外: このセルは密度一覧の分析グリッド（計画モード・デスクトップ）で、
// 44化すると18行で+324px伸びて一覧性が失われる。時刻選択の主経路はHourlyStrip（44px対応済み）。
const CELL_H = 26;

export default function ZoneTimeline({ zones, scenario, hour, onHourChange }: Props) {
  const hours = useMemo(
    () => Array.from({ length: VENUE.close - VENUE.open + 1 }, (_, i) => VENUE.open + i),
    []
  );

  // 時刻ごとに1回だけ予報を回し、ゾーンIDで引けるようにする
  const grid = useMemo(() => {
    const byHour = new Map<number, Map<string, { wbgt: number; shade: number }>>();
    for (const h of hours) {
      const m = new Map<string, { wbgt: number; shade: number }>();
      for (const f of forecastZones(zones, h, scenario)) {
        m.set(f.zone.id, { wbgt: f.wbgt, shade: f.shadeFraction });
      }
      byHour.set(h, m);
    }
    return byHour;
  }, [zones, scenario, hours]);

  const cols = hours.length;

  return (
    <section
      style={{
        background: INK.surface,
        border: `1px solid ${INK.line}`,
        borderRadius: 14,
        padding: 16,
      }}
      aria-label="ゾーン別の危険度タイムライン"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <div>
          <div className="cw-mono" style={{ fontSize: 13, letterSpacing: 1.5, color: INK.textFaint }}>
            ZONE TIMELINE ── ゾーン別 日陰率 × WBGT
          </div>
          <div style={{ fontWeight: 600, fontSize: 15, marginTop: 3 }}>ここが、いつ、危険になるか</div>
        </div>
        <div
          className="cw-mono"
          style={{ display: "flex", gap: 12, fontSize: 13, color: INK.textFaint, flexWrap: "wrap" }}
        >
          {WBGT_BANDS.map((b) => (
            <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 9, height: 9, background: b.color, borderRadius: 2, display: "inline-block" }} />
              {b.label}
            </span>
          ))}
          <span>／ セル下の塗り = 日陰率</span>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 620 }}>
          {/* 時刻軸 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `132px repeat(${cols}, 1fr)`,
              gap: 2,
              marginBottom: 5,
            }}
          >
            <div />
            {hours.map((h) => (
              <div
                key={h}
                className="cw-mono"
                style={{
                  fontSize: 13,
                  color: h === hour ? INK.accent : INK.textFaint,
                  textAlign: "center",
                  fontWeight: h === hour ? 700 : 400,
                }}
              >
                {h}
              </div>
            ))}
          </div>

          {zones.map((z) => (
            <div
              key={z.id}
              style={{
                display: "grid",
                gridTemplateColumns: `132px repeat(${cols}, 1fr)`,
                gap: 2,
                marginBottom: 3,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: INK.textDim,
                  paddingLeft: 4,
                  display: "flex",
                  alignItems: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {z.name}
              </div>
              {hours.map((h) => {
                const cell = grid.get(h)?.get(z.id);
                if (!cell) return <div key={h} style={{ height: CELL_H }} />;
                const band = wbgtBand(cell.wbgt);
                return (
                  <button
                    key={h}
                    onClick={() => onHourChange(h)}
                    title={`${z.name} ${h}:00 ／ WBGT ${cell.wbgt} ${band.label} ／ 日陰 ${Math.round(cell.shade * 100)}%`}
                    aria-label={`${z.name} ${h}時 WBGT ${cell.wbgt} 日陰${Math.round(cell.shade * 100)}パーセント`}
                    style={{
                      height: CELL_H,
                      background: `${band.color}33`,
                      border: "none",
                      borderRadius: 3,
                      position: "relative",
                      padding: 0,
                      cursor: "pointer",
                      outline: h === hour ? `1.5px solid ${INK.accent}` : "none",
                      overflow: "hidden",
                    }}
                  >
                    {/* 下から伸びる塗り = 日陰率 */}
                    <span
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: `${cell.shade * 100}%`,
                        background: band.color,
                        transition: "height 250ms ease",
                      }}
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
