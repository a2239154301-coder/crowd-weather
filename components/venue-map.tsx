"use client";

import { useMemo, useState } from "react";
import type { Point, Scenario, Zone } from "@/lib/forecast/types";
import { VENUE } from "@/lib/forecast/venue";
import { centroid, forecastZones, shadowsAt, sunAt, toPath } from "@/lib/forecast/model";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";

export type MapLayer = "crowd" | "heat";

export type StaffMark = { at: Point; role: "water" | "guide" | "aid"; label: string };

const GROUND_FILL: Record<string, string> = {
  water: "#0E2136",
  grass: "#13251F",
  paved: "#151C2B",
  deck: "#1A1E2C",
};

const ROLE_COLOR: Record<StaffMark["role"], string> = {
  water: "#38BDF8",
  guide: "#FDE047",
  aid: "#22C55E",
};
const ROLE_GLYPH: Record<StaffMark["role"], string> = { water: "水", guide: "誘", aid: "救" };

type Props = {
  zones: Zone[];
  hour: number;
  scenario: Scenario;
  layer: MapLayer;
  /** 日陰だけを浮かび上がらせる（来場者向けの「涼しい側」表示） */
  emphasizeShade?: boolean;
  staff?: StaffMark[];
  /** 小さく描く（計画書の添付図など） */
  compact?: boolean;
};

export default function VenueMap({
  zones,
  hour,
  scenario,
  layer,
  emphasizeShade = false,
  staff,
  compact = false,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  const shadows = useMemo(() => shadowsAt(hour, scenario.date), [hour, scenario.date]);
  const forecast = useMemo(() => forecastZones(zones, hour, scenario), [zones, hour, scenario]);
  const sun = sunAt(hour, scenario.date);
  const night = sun.altitudeDeg <= 3;

  const active = forecast.find((f) => f.zone.id === hovered) ?? null;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox={`0 0 ${VENUE.width} ${VENUE.height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          background: night ? "#080C14" : INK.surface,
          borderRadius: 14,
          border: `1px solid ${INK.line}`,
          transition: "background 600ms ease",
        }}
        role="img"
        aria-label={`${VENUE.name} の ${hour}時の${layer === "crowd" ? "混雑" : "暑熱"}予報`}
      >
        <defs>
          {/* 危険域には45°のハッチを重ねる。色だけに意味を持たせないため */}
          <pattern id="cw-hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#000" strokeOpacity="0.34" strokeWidth="3" />
          </pattern>
          <filter id="cw-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>

        {/* 1. 地面 */}
        {VENUE.ground.map((g) => (
          <path key={g.id} d={toPath(g.shape)} fill={GROUND_FILL[g.kind]} />
        ))}

        {/* 2. 影（建物 footprint × 太陽位置から計算） */}
        <g style={{ transition: "opacity 500ms ease" }} opacity={night ? 0 : 1}>
          {shadows.map((s) => (
            <path key={s.building.id} d={toPath(s.shape)} fill="#050A12" fillOpacity={0.5} />
          ))}
        </g>

        {/* 3. 建物 */}
        {VENUE.buildings.map((b) => (
          <path
            key={b.id}
            d={toPath(b.shape)}
            fill="#0D1420"
            stroke="#2B3A55"
            strokeWidth={1.2}
          />
        ))}

        {/* 4. ゾーン */}
        {forecast.map((f) => {
          const band = layer === "crowd" ? densityBand(f.density) : wbgtBand(f.wbgt);
          const value = layer === "crowd" ? f.density : f.wbgt;
          const dimmed = emphasizeShade && !f.shaded;
          const critical = band.severity === 3;
          const c = f.zone.label ?? centroid(f.zone.shape);
          const isHover = hovered === f.zone.id;
          return (
            <g
              key={f.zone.id}
              onMouseEnter={() => setHovered(f.zone.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "default" }}
            >
              {critical && !dimmed && (
                <path d={toPath(f.zone.shape)} fill={band.color} opacity={0.34} filter="url(#cw-soft)" />
              )}
              <path
                d={toPath(f.zone.shape)}
                fill={band.color}
                fillOpacity={dimmed ? 0.07 : isHover ? 0.4 : 0.26}
                stroke={band.color}
                strokeOpacity={dimmed ? 0.35 : 1}
                strokeWidth={isHover ? 2.4 : 1.6}
                style={{ transition: "fill 450ms ease, fill-opacity 200ms ease, stroke-width 120ms ease" }}
              />
              {critical && !dimmed && <path d={toPath(f.zone.shape)} fill="url(#cw-hatch)" />}
              {!compact && (
                <>
                  <text
                    x={c.x}
                    y={c.y - 4}
                    textAnchor="middle"
                    fontSize={13}
                    fill={INK.text}
                    style={{ pointerEvents: "none", fontWeight: 500 }}
                  >
                    {f.zone.name}
                  </text>
                  <text
                    x={c.x}
                    y={c.y + 15}
                    textAnchor="middle"
                    fontSize={15}
                    fill={band.color}
                    className="cw-mono"
                    style={{ pointerEvents: "none", fontWeight: 600 }}
                  >
                    {value}
                    <tspan fontSize={10} fill={INK.textDim} className="cw-mono">
                      {" "}
                      {band.label}
                    </tspan>
                  </text>
                </>
              )}
              {f.shaded && layer === "heat" && !compact && (
                <text x={c.x} y={c.y - 20} textAnchor="middle" fontSize={12} fill="#7DD3FC">
                  日陰
                </text>
              )}
            </g>
          );
        })}

        {/* 5. スタッフ配置 */}
        {staff?.map((m, i) => (
          <g key={i}>
            <circle cx={m.at.x} cy={m.at.y} r={13} fill={ROLE_COLOR[m.role]} stroke="#0A0E17" strokeWidth={2.5} />
            <text
              x={m.at.x}
              y={m.at.y + 5}
              textAnchor="middle"
              fontSize={13}
              fontWeight={700}
              fill="#0A0E17"
            >
              {ROLE_GLYPH[m.role]}
            </text>
          </g>
        ))}

        {/* 6. 会場図としての作法：方位と縮尺 */}
        <g opacity={0.75}>
          <line x1={946} y1={82} x2={946} y2={44} stroke={INK.textDim} strokeWidth={1.4} />
          <path d="M946 40 L942 50 L950 50 Z" fill={INK.textDim} />
          <text x={946} y={97} textAnchor="middle" fontSize={11} fill={INK.textDim}>N</text>
        </g>
        <g opacity={0.7} transform="translate(40, 668)">
          <line x1={0} y1={0} x2={125} y2={0} stroke={INK.textDim} strokeWidth={1.4} />
          <line x1={0} y1={-4} x2={0} y2={4} stroke={INK.textDim} strokeWidth={1.4} />
          <line x1={125} y1={-4} x2={125} y2={4} stroke={INK.textDim} strokeWidth={1.4} />
          <text x={62} y={-8} textAnchor="middle" fontSize={11} fill={INK.textDim} className="cw-mono">
            50m
          </text>
        </g>
      </svg>

      {active && !compact && (
        <div
          role="status"
          style={{
            position: "absolute",
            left: 12,
            top: 12,
            background: "rgba(10,14,23,0.94)",
            border: `1px solid ${INK.line}`,
            borderRadius: 10,
            padding: "10px 13px",
            pointerEvents: "none",
            minWidth: 190,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: INK.text }}>{active.zone.name}</div>
          <div style={{ marginTop: 6, display: "grid", gap: 3, fontSize: 12 }}>
            <Row
              label="混雑"
              value={`${active.density}`}
              band={densityBand(active.density).label}
              color={densityBand(active.density).color}
            />
            <Row
              label="暑熱"
              value={`${active.wbgt}`}
              band={wbgtBand(active.wbgt).label}
              color={wbgtBand(active.wbgt).color}
            />
            <div style={{ color: INK.textDim, fontSize: 11 }}>
              {hour}:00 ／ {active.shaded ? "日陰" : "日なた"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, band, color }: { label: string; value: string; band: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ color: INK.textDim, width: 30 }}>{label}</span>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: "inline-block" }} />
      <span className="cw-mono" style={{ color: INK.text, fontWeight: 600 }}>
        {value}
      </span>
      <span style={{ color: INK.textDim }}>{band}</span>
    </div>
  );
}
