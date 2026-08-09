"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VENUE } from "@/lib/forecast/venue";
import { toPath } from "@/lib/forecast/model";
import { computeHeatField, sampleZone, type HeatConditions } from "@/lib/forecast/heatfield";
import { INK, WBGT_BANDS, wbgtBand } from "@/lib/forecast/scales";

/**
 * 連続ヒートマップ。
 * 下地はcanvas（格子ごとのWBGT）、その上にSVGで建物・ゾーン・方位・風を重ねる。
 * 色は4段階の帯にする。連続グラデーションより、しきい値がどこかが読めるほうが現場で使える。
 */

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const BAND_RGB = WBGT_BANDS.map((b) => hexToRgb(b.color));

export default function HeatMap({ conditions }: { conditions: HeatConditions }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; wbgt: number } | null>(null);

  const field = useMemo(() => computeHeatField(conditions, 8), [conditions]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = field.cols;
    cv.height = field.rows;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(field.cols, field.rows);
    // 帯の下限（環境省の暑さ指数の区分に合わせる）
    const FLOOR = [21, 25, 28, 31];
    for (let k = 0; k < field.cols * field.rows; k++) {
      const v = field.wbgt[k];
      const band = wbgtBand(v);
      const [r, g, b] = BAND_RGB[band.severity];
      // 帯の中でも値が高いほど濃く。しきい値の位置は残しつつ、のっぺりさせない
      const within = Math.min(1, Math.max(0, (v - FLOOR[band.severity]) / 3));
      const a = 112 + within * 96;
      img.data[k * 4] = r;
      img.data[k * 4 + 1] = g;
      img.data[k * 4 + 2] = b;
      img.data[k * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
  }, [field]);

  const zoneStats = useMemo(
    () =>
      VENUE.zones
        .filter((z) => !z.roofed)
        .map((z) => ({ zone: z, ...sampleZone(field, z.shape) }))
        .sort((a, b) => b.max - a.max)
        .slice(0, 3),
    [field]
  );

  const sunRad = (field.sun.azimuthDeg * Math.PI) / 180;
  const windRad = (conditions.windFromDeg * Math.PI) / 180;

  return (
    <div>
      <div
        style={{ position: "relative", width: "100%", borderRadius: 14, overflow: "hidden", border: `1px solid ${INK.line}` }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const fx = ((e.clientX - r.left) / r.width) * VENUE.width;
          const fy = ((e.clientY - r.top) / r.height) * VENUE.height;
          const i = Math.floor(fx / field.cell);
          const j = Math.floor(fy / field.cell);
          if (i < 0 || j < 0 || i >= field.cols || j >= field.rows) return setHover(null);
          setHover({ x: fx, y: fy, wbgt: field.wbgt[j * field.cols + i] });
        }}
        onMouseLeave={() => setHover(null)}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", display: "block", background: "#0B111C" }}
          aria-label="暑さ指数のヒートマップ"
        />
        <svg
          viewBox={`0 0 ${VENUE.width} ${VENUE.height}`}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        >
          {/* 建物 */}
          {VENUE.buildings.map((b) => (
            <path key={b.id} d={toPath(b.shape)} fill="#0B1120" stroke="#3A4C6E" strokeWidth={1.3} />
          ))}
          {/* ゾーンの輪郭だけ（塗りはヒートマップに任せる） */}
          {VENUE.zones.map((z) => (
            <path
              key={z.id}
              d={toPath(z.shape)}
              fill="none"
              stroke="#FFFFFF"
              strokeOpacity={0.24}
              strokeWidth={1.1}
              strokeDasharray="4 3"
            />
          ))}
          {zoneStats.map((s) => {
            const c = s.zone.label ?? {
              x: s.zone.shape.reduce((a, p) => a + p.x, 0) / s.zone.shape.length,
              y: s.zone.shape.reduce((a, p) => a + p.y, 0) / s.zone.shape.length,
            };
            return (
              <g key={s.zone.id}>
                <text x={c.x} y={c.y - 3} textAnchor="middle" fontSize={13} fill="#fff" fontWeight={600}>
                  {s.zone.name}
                </text>
                <text x={c.x} y={c.y + 15} textAnchor="middle" fontSize={14} fill="#fff" className="cw-mono">
                  {s.max.toFixed(1)}
                </text>
              </g>
            );
          })}

          {/* 太陽の方位と風向。会場図の作法として右上にまとめる */}
          <g transform="translate(908, 92)">
            <circle r={44} fill="rgba(10,14,23,0.72)" stroke={INK.line} />
            <circle r={44} fill="none" stroke={INK.line} strokeDasharray="2 4" />
            <text y={-32} textAnchor="middle" fontSize={10} fill={INK.textDim}>N</text>
            {field.sun.altitudeDeg > 0 && (
              <>
                <line
                  x1={0}
                  y1={0}
                  x2={Math.sin(sunRad) * 34}
                  y2={-Math.cos(sunRad) * 34}
                  stroke="#FBBF24"
                  strokeWidth={2.4}
                />
                <circle cx={Math.sin(sunRad) * 34} cy={-Math.cos(sunRad) * 34} r={6} fill="#FBBF24" />
              </>
            )}
            <line
              x1={Math.sin(windRad) * 30}
              y1={-Math.cos(windRad) * 30}
              x2={-Math.sin(windRad) * 30}
              y2={Math.cos(windRad) * 30}
              stroke="#7DD3FC"
              strokeWidth={2}
              markerEnd="url(#windhead)"
            />
            <text y={58} textAnchor="middle" fontSize={9.5} fill={INK.textDim} className="cw-mono">
              太陽 {Math.round(field.sun.azimuthDeg)}° / {Math.round(field.sun.altitudeDeg)}°
            </text>
            <text y={70} textAnchor="middle" fontSize={9.5} fill="#7DD3FC" className="cw-mono">
              風 {Math.round(conditions.windFromDeg)}° {conditions.windSpeed}m/s
            </text>
          </g>
          <defs>
            <marker id="windhead" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0 0 L7 3.5 L0 7 Z" fill="#7DD3FC" />
            </marker>
          </defs>
        </svg>

        {hover && (
          <div
            className="cw-mono"
            style={{
              position: "absolute",
              left: 12,
              top: 12,
              background: "rgba(10,14,23,0.94)",
              border: `1px solid ${INK.line}`,
              borderRadius: 9,
              padding: "8px 12px",
              fontSize: 12,
              pointerEvents: "none",
            }}
          >
            WBGT{" "}
            <span style={{ color: wbgtBand(hover.wbgt).color, fontWeight: 700, fontSize: 15 }}>
              {hover.wbgt.toFixed(1)}
            </span>{" "}
            <span style={{ color: INK.textDim }}>{wbgtBand(hover.wbgt).label}</span>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        {WBGT_BANDS.map((b, i) => (
          <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: INK.textDim }}>
            <span style={{ width: 13, height: 13, borderRadius: 3, background: b.color }} />
            {b.label}
            <span className="cw-mono" style={{ color: INK.textFaint }}>
              {["<25", "25–28", "28–31", "31≦"][i]}
            </span>
          </span>
        ))}
        <span className="cw-mono" style={{ marginLeft: "auto", fontSize: 11, color: INK.textFaint }}>
          場内 {field.min.toFixed(1)} – {field.max.toFixed(1)} ℃ ／ 格子 {field.cols}×{field.rows}
        </span>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
        {zoneStats.map((s) => (
          <div
            key={s.zone.id}
            style={{
              background: INK.surface,
              border: `1px solid ${wbgtBand(s.max).color}55`,
              borderRadius: 11,
              padding: "10px 13px",
            }}
          >
            <div style={{ fontSize: 11, color: INK.textFaint }}>最も暑い場所 {zoneStats.indexOf(s) + 1}</div>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{s.zone.name}</div>
            <div className="cw-mono" style={{ fontSize: 12, color: wbgtBand(s.max).color, marginTop: 3 }}>
              最大 {s.max.toFixed(1)} ／ 平均 {s.mean.toFixed(1)} ・ {wbgtBand(s.max).label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
