"use client";

import { useMemo, useState } from "react";
import type { Point, Scenario, Zone } from "@/lib/forecast/types";
import { VENUE } from "@/lib/forecast/venue";
import { centroid, forecastZones, shadowsAt, sunAt, toPath } from "@/lib/forecast/model";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import { riskLabel, timeBand, zoneRisks, type ZoneRisk } from "@/lib/forecast/risk";

/**
 * `risk` = 総合リスク予報（2026-08-12 追加）。色が「いまの値」ではなく
 * 「危険帯に入るまでの残り時間」を表す。crowd / heat の挙動は変えていない。
 */
export type MapLayer = "crowd" | "heat" | "risk";

export type StaffMark = { at: Point; role: "water" | "guide" | "aid"; label: string };

/**
 * 地面と建物の明度（2026-08-12 引き上げ）。
 *
 * 「元のステージ等が見えなさ過ぎて何を表しているのか分からない」への対応。
 * 従来は暗い背景に建物 #0D1420（ほぼ黒）を置いていたため、会場図として読めなかった。
 * 会場が読めることが先で、予報はその上のオーバーレイという順序にする。
 */
const GROUND_FILL: Record<string, string> = {
  water: "#14344E",
  grass: "#1C3A2C",
  paved: "#222C42",
  deck: "#262A3B",
};

const BUILDING_FILL = "#33415C";
const BUILDING_STROKE = "#6E86B2";

/**
 * ラベルの逃がし位置。**`venue.ts` の `Zone.label` には足さないこと** —
 * あちらは `route.ts` の `anchorOf()` が経路探索の起点に使っており、
 * 動かすと `route.test.ts` の固定値が壊れる。表示の都合はここで吸収する。
 */
const LABEL_NUDGE: Record<string, Point> = {
  // 駅連絡通路と駅前広場は実際に重なっている。左右に振り分ける
  corr: { x: 500, y: 104 },
  plaza: { x: 368, y: 118 },
  // 駅ビルの中の細長い2ゾーン
  plat: { x: 500, y: 30 },
  conc: { x: 500, y: 60 },
  // 右上は方位コンパスの定位置。重心のままだと "S" とぶつかるので左へ寄せる
  blvd: { x: 818, y: 112 },
};

/** 縦に細いゾーンは名前と状態を1行にまとめる（2行だと枠からはみ出す） */
const THIN_ZONE = 52;

function bboxHeight(shape: Point[]): number {
  const ys = shape.map((p) => p.y);
  return Math.max(...ys) - Math.min(...ys);
}

function inPolygon(p: Point, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

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
  /**
   * NOW/PEAKバッジ（馬場氏要望 08-13・スケッチ準拠でコンパス左隣に出す）。
   * `hour === nowHour` でNOW、`hour === peakHour` でPEAK。渡さなければ出ない。
   */
  nowHour?: number | null;
  peakHour?: number | null;
  /**
   * タップ2回で移動指示（調整コンソール配置ボード 2026-08-13 追加）。
   * すべてoptional・未指定時は従来描画と完全一致する。
   */
  /** スタッフ丸のタップ。指定時のみ丸が cursor:pointer になる */
  onStaffClick?: (index: number) => void;
  /** 選択中マーカー（白リング r+4 で強調） */
  selectedStaffIndex?: number | null;
  /** ゾーンのタップ（移動先選択）。指定時のみゾーンパスが cursor:pointer */
  onZoneClick?: (zoneId: string) => void;
  /** ゾーン別人数バッジ {zoneId: 人数}。ゾーンラベルの上に「N人」ピルを描く */
  zoneBadges?: Record<string, number>;
  /** マーカーの薄表示index集合（空席ポスト用・クリック不可・opacity 0.35） */
  dimmedStaffIndices?: ReadonlySet<number>;
};

export default function VenueMap({
  zones,
  hour,
  scenario,
  layer,
  emphasizeShade = false,
  staff,
  compact = false,
  nowHour = null,
  peakHour = null,
  onStaffClick,
  selectedStaffIndex = null,
  onZoneClick,
  zoneBadges,
  dimmedStaffIndices,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  const shadows = useMemo(
    () => shadowsAt(hour, scenario.date, scenario.geo),
    [hour, scenario.date, scenario.geo]
  );
  const plain = useMemo(() => forecastZones(zones, hour, scenario), [zones, hour, scenario]);
  // リスク層は hour 以降の全時刻を走査するので、そのレイヤーのときだけ計算する
  const risks = useMemo(
    () => (layer === "risk" ? zoneRisks(zones, hour, scenario) : null),
    [layer, zones, hour, scenario]
  );
  const forecast = risks ?? plain;
  const sun = sunAt(hour, scenario.date, scenario.geo);
  const night = sun.altitudeDeg <= 3;

  const active = forecast.find((f) => f.zone.id === hovered) ?? null;
  const activeRisk = risks?.find((r) => r.zone.id === hovered) ?? null;

  /**
   * 建物名は、ゾーンと重なっていない建物にだけ出す。
   * 駅ビルのようにゾーンを内包する建物へ名前を置くと、
   * ホーム・改札のラベルの隙間に割り込んで3行が重なる。
   */
  const buildingLabels = useMemo(() => {
    if (compact) return [];
    return VENUE.buildings
      .map((b) => ({ b, c: centroid(b.shape) }))
      .filter(
        ({ b, c }) =>
          !zones.some((z) => inPolygon(c, z.shape) || inPolygon(centroid(z.shape), b.shape))
      );
  }, [zones, compact]);

  const layerName = layer === "crowd" ? "混雑" : layer === "heat" ? "暑熱" : "リスク";

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
        aria-label={`${VENUE.name} の ${hour}時の${layerName}予報`}
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
            fill={BUILDING_FILL}
            stroke={BUILDING_STROKE}
            strokeWidth={1.2}
          />
        ))}
        {buildingLabels.map(({ b, c }) => (
          <text
            key={b.id}
            x={c.x}
            y={c.y + 4}
            textAnchor="middle"
            fontSize={13}
            fill={INK.textDim}
            stroke={INK.page}
            strokeWidth={3}
            paintOrder="stroke"
            style={{ pointerEvents: "none" }}
          >
            {b.name}
          </text>
        ))}

        {/* 4. ゾーン */}
        {forecast.map((f) => {
          const risk = risks ? (f as ZoneRisk) : null;
          const band =
            layer === "crowd"
              ? densityBand(f.density)
              : layer === "heat"
                ? wbgtBand(f.wbgt)
                : timeBand(risk!.hoursToDanger);
          const value = layer === "crowd" ? f.density : f.wbgt;
          const dimmed = emphasizeShade && !f.shaded;
          const critical = band.severity === 3;
          const c = LABEL_NUDGE[f.zone.id] ?? f.zone.label ?? centroid(f.zone.shape);
          const isHover = hovered === f.zone.id;
          const thin = bboxHeight(f.zone.shape) < THIN_ZONE;
          const zoneClickable = Boolean(onZoneClick);
          return (
            <g
              key={f.zone.id}
              onMouseEnter={() => setHovered(f.zone.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={zoneClickable ? () => onZoneClick!(f.zone.id) : undefined}
              role={zoneClickable ? "button" : undefined}
              aria-label={zoneClickable ? `${f.zone.name}へ移動先指定` : undefined}
              style={{ cursor: zoneClickable ? "pointer" : "default" }}
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
              {!compact && thin && (
                /* 細長いゾーンは2行だと枠からはみ出すので1行にまとめる */
                <text
                  x={c.x}
                  y={c.y + 5}
                  textAnchor="middle"
                  fontSize={13}
                  fill={INK.text}
                  stroke={INK.page}
                  strokeWidth={3.5}
                  paintOrder="stroke"
                  style={{ pointerEvents: "none", fontWeight: 500 }}
                >
                  {f.zone.name}{" "}
                  <tspan fill={band.color} className="cw-mono">
                    {risk ? riskLabel(risk) : `${value} ${band.label}`}
                  </tspan>
                </text>
              )}
              {!compact && !thin && (
                <>
                  <text
                    x={c.x}
                    y={c.y - 4}
                    textAnchor="middle"
                    fontSize={13}
                    fill={INK.text}
                    stroke={INK.page}
                    strokeWidth={3.5}
                    paintOrder="stroke"
                    style={{ pointerEvents: "none", fontWeight: 500 }}
                  >
                    {f.zone.name}
                  </text>
                  {risk ? (
                    <text
                      x={c.x}
                      y={c.y + 16}
                      textAnchor="middle"
                      fontSize={14}
                      fill={band.color}
                      className="cw-mono"
                      stroke={INK.page}
                      strokeWidth={3.5}
                      paintOrder="stroke"
                      style={{ pointerEvents: "none", fontWeight: 600 }}
                    >
                      {riskLabel(risk)}
                    </text>
                  ) : (
                    <text
                      x={c.x}
                      y={c.y + 15}
                      textAnchor="middle"
                      fontSize={15}
                      fill={band.color}
                      className="cw-mono"
                      stroke={INK.page}
                      strokeWidth={3.5}
                      paintOrder="stroke"
                      style={{ pointerEvents: "none", fontWeight: 600 }}
                    >
                      {value}
                      <tspan fontSize={13} fill={INK.textDim} className="cw-mono">
                        {" "}
                        {band.label}
                      </tspan>
                    </text>
                  )}
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

        {/* 4.5 ゾーン別人数バッジ（調整コンソール配置ボード 2026-08-13 追加） */}
        {zoneBadges &&
          Object.entries(zoneBadges).map(([zoneId, n]) => {
            if (!n) return null;
            const z = zones.find((zz) => zz.id === zoneId);
            if (!z) return null;
            const c = LABEL_NUDGE[zoneId] ?? z.label ?? centroid(z.shape);
            const label = `${n}人`;
            const w = Math.max(30, 16 + label.length * 8);
            const h = 18;
            const by = c.y - 22;
            return (
              <g key={zoneId} style={{ pointerEvents: "none" }}>
                <rect
                  x={c.x - w / 2}
                  y={by - h / 2}
                  width={w}
                  height={h}
                  rx={8}
                  fill={INK.raised}
                  stroke={INK.line}
                  strokeWidth={1}
                />
                <text
                  x={c.x}
                  y={by + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fill={INK.text}
                  className="cw-mono"
                >
                  {label}
                </text>
              </g>
            );
          })}

        {/* 5. スタッフ配置 */}
        {staff?.map((m, i) => {
          const dimmed = dimmedStaffIndices?.has(i) ?? false;
          const selected = selectedStaffIndex === i;
          const clickable = !dimmed && Boolean(onStaffClick);
          return (
            <g
              key={i}
              opacity={dimmed ? 0.35 : 1}
              onClick={
                clickable
                  ? (e) => {
                      e.stopPropagation();
                      onStaffClick!(i);
                    }
                  : undefined
              }
              style={{ cursor: clickable ? "pointer" : "default" }}
            >
              {selected && (
                <circle cx={m.at.x} cy={m.at.y} r={17} fill="none" stroke="#FFFFFF" strokeWidth={3} />
              )}
              <circle cx={m.at.x} cy={m.at.y} r={13} fill={ROLE_COLOR[m.role]} stroke="#0A0E17" strokeWidth={2.5} />
              <text
                x={m.at.x}
                y={m.at.y + 5}
                textAnchor="middle"
                fontSize={13}
                fontWeight={700}
                fill="#0A0E17"
                style={{ pointerEvents: "none" }}
              >
                {ROLE_GLYPH[m.role]}
              </text>
              {!compact && (
                <text
                  x={m.at.x}
                  y={m.at.y + 18}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill={INK.text}
                  stroke={INK.page}
                  strokeWidth={3}
                  paintOrder="stroke"
                  style={{ pointerEvents: "none" }}
                >
                  {m.label}
                </text>
              )}
            </g>
          );
        })}

        {/* 6. 会場図としての作法：方位・太陽・縮尺 */}
        <SunCompass sun={sun} night={night} hour={hour} compact={compact} />
        {!compact && (
          <TimeBadges now={hour === nowHour} peak={hour === peakHour} />
        )}
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
          <div style={{ marginTop: 6, display: "grid", gap: 3, fontSize: 13 }}>
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
            {activeRisk && (
              <Row
                label="予報"
                value={riskLabel(activeRisk)}
                band={activeRisk.dangerCause ?? activeRisk.cause ?? "要因なし"}
                color={timeBand(activeRisk.hoursToDanger).color}
              />
            )}
            <div style={{ color: INK.textDim, fontSize: 13 }}>
              {hour}:00 ／ {active.shaded ? "日陰" : "日なた"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 方位＋太陽の位置（馬場v4の方位コンパスを移植）。
 *
 * 実線＝太陽の方位、破線＝影が伸びる向き。画面の影と必ず一致する
 * （どちらも同じ `sunAt()` の方位角から描いているため）。
 * 「なぜこの時間にここが日陰なのか」を、地図を見ただけで説明できるようにする部品。
 */
function SunCompass({
  sun,
  night,
  hour,
  compact,
}: {
  sun: { azimuthDeg: number; altitudeDeg: number };
  night: boolean;
  hour: number;
  compact: boolean;
}) {
  const cx = 928;
  const cy = 74;
  const r = compact ? 26 : 34;
  const rad = (sun.azimuthDeg * Math.PI) / 180;
  // 画面座標: x=東(右) / y=南(下)。方位角0=北なので (sin, -cos)
  const sx = cx + Math.sin(rad) * r * 0.72;
  const sy = cy - Math.cos(rad) * r * 0.72;
  // 影は太陽の逆方向へ伸びる
  const shx = cx - Math.sin(rad) * r * 0.92;
  const shy = cy + Math.cos(rad) * r * 0.92;

  return (
    <g opacity={0.85} aria-hidden>
      <circle cx={cx} cy={cy} r={r} fill="rgba(10,14,23,0.5)" stroke={INK.line} strokeWidth={1.4} />
      <text x={cx} y={cy - r - 6} textAnchor="middle" fontSize={11} fill={INK.textDim} className="cw-mono">N</text>
      <text x={cx} y={cy + r + 15} textAnchor="middle" fontSize={11} fill={INK.textFaint} className="cw-mono">S</text>
      <text x={cx + r + 10} y={cy + 4} textAnchor="middle" fontSize={11} fill={INK.textFaint} className="cw-mono">E</text>
      <text x={cx - r - 10} y={cy + 4} textAnchor="middle" fontSize={11} fill={INK.textFaint} className="cw-mono">W</text>

      {night ? (
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fill={INK.textFaint}>
          日没後
        </text>
      ) : (
        <g style={{ transition: "opacity 400ms ease" }}>
          {/* 影の向き（破線） */}
          <line
            x1={cx}
            y1={cy}
            x2={shx}
            y2={shy}
            stroke={INK.textFaint}
            strokeWidth={1.6}
            strokeDasharray="4 3"
          />
          {/* 太陽の向き（実線＋点） */}
          <line x1={cx} y1={cy} x2={sx} y2={sy} stroke="#FDE047" strokeWidth={2.2} />
          <circle cx={sx} cy={sy} r={6} fill="#FDE047" />
          {!compact && (
            <text x={cx} y={cy + r + 30} textAnchor="middle" fontSize={10} fill={INK.textFaint} className="cw-mono">
              {hour}:00 高度{sun.altitudeDeg.toFixed(0)}°
            </text>
          )}
        </g>
      )}
    </g>
  );
}

/**
 * NOW / PEAK バッジ（コンパスの左隣・水色ピル＝馬場氏スケッチ準拠）。
 * NOW = 表示中の時刻が実時刻と一致。PEAK = 会場全体の危険度合計が最大の時刻
 * （`venuePeakHour()`）。両方成立時はNOWを左に並べる。
 */
function TimeBadges({ now, peak }: { now: boolean; peak: boolean }) {
  if (!now && !peak) return null;
  const H = 30;
  const W = 74;
  const GAP = 8;
  const rightEdge = 880; // コンパス円(cx928, r34)の左端から14px空ける
  const y = 59; // 中心をコンパス中心(74)に合わせる
  const badges: { label: string; fill: string; text: string }[] = [];
  if (now) badges.push({ label: "NOW", fill: "#7DD3FC", text: "#0A0E17" });
  if (peak) badges.push({ label: "PEAK", fill: "#E5254A", text: "#FFFFFF" });
  return (
    <g>
      {badges.map((b, i) => {
        const x = rightEdge - (badges.length - i) * W - (badges.length - 1 - i) * GAP;
        return (
          <g key={b.label}>
            <rect x={x} y={y} width={W} height={H} rx={H / 2} fill={b.fill} stroke="#0A0E17" strokeWidth={1.5} />
            <text
              x={x + W / 2}
              y={y + H / 2 + 5}
              textAnchor="middle"
              fontSize={15}
              fontWeight={800}
              fill={b.text}
              className="cw-mono"
              style={{ letterSpacing: 1.5 }}
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </g>
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
