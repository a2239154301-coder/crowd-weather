import type { Building, DayPlan, EventDate, Point, Scenario, VenueGeo, Zone, ZoneForecast } from "./types";
import { HOURS, VENUE, IN_ZONE_IDS, DEFAULT_SCENARIO } from "./venue";
import { solarPosition, type GeoPoint } from "./solar";
import { wbgtPhysical } from "./wbgt";
import { tentPlan } from "./tent";

/**
 * 予報モデル。**LLMを一切呼ばない。** 決定的な計算だけで構成する。
 * これが審査項目⑥（LLMコスト）の設計の中心：主処理をLLMに投げない。
 *
 * 日陰は文字列フラグではなく、建物の footprint と太陽位置から
 * 影の多角形を実際に計算する。画面に描く影と、WBGTに効く日陰判定が同じ計算から出るので、
 * 「絵と数字が食い違わない」。
 */

// ── 幾何 ───────────────────────────────────────────────────────────

export function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** 交差判定（ray casting）。凹多角形でも正しい。 */
export function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const straddles = a.y > pt.y !== b.y > pt.y;
    if (straddles && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 凸包（Andrew's monotone chain）。footprint と、それを平行移動した形の和を包む。 */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (src: Point[]) => {
    const out: Point[] = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

// ── 太陽と影 ────────────────────────────────────────────────────────

/** viewBox 1単位あたりの実長さの逆数。1000幅 ≒ 400m 想定 */
const UNITS_PER_METER = 2.5;

/** 会場の位置の既定値（東京）。Scenario.geo が渡されればそちらを使う */
const DEFAULT_GEO_POINT: GeoPoint = { lat: 35.6895, lon: 139.6917, tzOffsetHours: 9 };

/** Scenario.geo（緯度経度のみ）を太陽計算用の GeoPoint に変換。国内前提で TZ は +9 固定 */
const toGeoPoint = (geo?: VenueGeo): GeoPoint =>
  geo ? { lat: geo.lat, lon: geo.lon, tzOffsetHours: 9 } : DEFAULT_GEO_POINT;

export type Sun = {
  /** 方位角（度・北0/東90/南180/西270） */
  azimuthDeg: number;
  /** 高度（度）。0以下は日没 */
  altitudeDeg: number;
  /** 日射の強さ 0-1 */
  intensity: number;
};

/**
 * 太陽位置。NOAA近似式（lib/forecast/solar.ts）で開催日から実計算する。
 * 2026-08-11、馬場v4の暑熱エンジン統合に合わせて
 * 従来の線形補間デモモデルを実計算に置き換えた（ヒートマップ試作と同じ式に一本化）。
 */
export function sunAt(hour: number, date?: EventDate, geo?: VenueGeo): Sun {
  const d = date ?? DEFAULT_SCENARIO.date;
  const p = solarPosition(new Date(Date.UTC(d.y, d.mo - 1, d.d)), hour, toGeoPoint(geo));
  return { azimuthDeg: p.azimuthDeg, altitudeDeg: p.altitudeDeg, intensity: p.intensity };
}

/**
 * 建物が落とす影の多角形。
 * 方位角Aの太陽に対し、影は逆向き (-sinA, +cosA) に伸びる（SVG座標: x=東, y=南）。
 */
export function shadowOf(b: Building, hour: number, date?: EventDate, geo?: VenueGeo): Point[] | null {
  const sun = sunAt(hour, date, geo);
  if (sun.altitudeDeg <= 3) return null;
  const rad = (sun.azimuthDeg * Math.PI) / 180;
  const len = Math.min(
    (b.height * UNITS_PER_METER) / Math.tan((sun.altitudeDeg * Math.PI) / 180),
    460
  );
  const dx = -Math.sin(rad) * len;
  const dy = Math.cos(rad) * len;
  const moved = b.shape.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  return convexHull([...b.shape, ...moved]);
}

export function shadowsAt(
  hour: number,
  date?: EventDate,
  geo?: VenueGeo
): { building: Building; shape: Point[] }[] {
  const out: { building: Building; shape: Point[] }[] = [];
  for (const b of VENUE.buildings) {
    const shape = shadowOf(b, hour, date, geo);
    if (shape) out.push({ building: b, shape });
  }
  return out;
}

/**
 * ゾーンのうち日陰になっている面積の割合（0-1）。
 *
 * 重心1点で判定すると「半分だけ影がかかっている」状態が数字に出ず、
 * 時間を進めても日陰率が階段状にしか動かない。ゾーン内を格子状にサンプリングして面積比で持つ。
 */
export function shadeFraction(
  zone: Zone,
  hour: number,
  shadows?: { shape: Point[] }[],
  date?: EventDate,
  geo?: VenueGeo
): number {
  if (zone.roofed) return 1;
  const sun = sunAt(hour, date, geo);
  if (sun.altitudeDeg <= 3) return 1; // 日没後は全域が日陰
  const sh = shadows ?? shadowsAt(hour, date, geo);
  if (sh.length === 0) return 0;

  const xs = zone.shape.map((p) => p.x);
  const ys = zone.shape.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];

  const N = 7; // 7x7 の格子。ゾーンの外側は数えない
  let inZone = 0;
  let inShade = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = {
        x: x0 + ((i + 0.5) / N) * (x1 - x0),
        y: y0 + ((j + 0.5) / N) * (y1 - y0),
      };
      if (!pointInPolygon(p, zone.shape)) continue;
      inZone++;
      if (sh.some((s) => pointInPolygon(p, s.shape))) inShade++;
    }
  }
  return inZone === 0 ? 0 : inShade / inZone;
}

/** 面積の半分以上が日陰か。表示用。 */
export function isShaded(zone: Zone, hour: number): boolean {
  return shadeFraction(zone, hour) >= 0.5;
}

// ── 混雑 ───────────────────────────────────────────────────────────

/** 時間帯別の在場率。実運用では入退場ゲートログで置き換える。 */
const OCCUPANCY: Record<number, number> = {
  11: 0.2, 12: 0.42, 13: 0.6, 14: 0.75, 15: 0.88,
  16: 0.95, 17: 0.9, 18: 0.82, 19: 0.8, 20: 0.72, 21: 0.55,
};

function occupancy(hour: number, tickets: number): number {
  return (OCCUPANCY[hour] ?? 0) * (tickets / 20000);
}

export function density(zone: Zone, hour: number, s: Scenario): number {
  const egress = hour >= VENUE.close - 1;
  const opening = hour === VENUE.open;
  let m = 1;

  if (zone.kind === "indoor") m *= s.weather === "rainy" ? 1.9 : s.weather === "sunny" ? 0.7 : 1.0;
  if (zone.kind === "stage") m *= s.weather === "rainy" ? 0.5 : 1.0;
  if (zone.kind === "gate") m *= opening ? 1.7 : egress ? 1.5 : 1.0;
  if (zone.kind === "corridor") {
    m *= egress ? (zone.id === "exit" || zone.id === "plaza" ? 2.1 : 1.9) : opening ? 1.5 : 0.5;
  }
  if (zone.kind === "station") m *= opening ? 1.8 : egress ? 2.2 : 0.45;
  if (zone.kind === "alley") m *= egress ? 2.4 : opening ? 1.4 : 0.55;
  if (zone.kind === "queue") {
    if (s.weather === "sunny") m *= 1.15;
    if (zone.id === "bus") m *= egress ? 1.9 : 0.7;
  }

  const raw = occupancy(hour, s.tickets) * zone.base * m * 95;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ── 暑熱 ───────────────────────────────────────────────────────────

/**
 * ゾーンのWBGT。物理エンジン（lib/forecast/wbgt.ts＝馬場v4から移植）で実計算する。
 *
 * 2026-08-11、従来の線形近似（21 + (T-28)*0.6 + …）を廃止。
 * 日射（Kasten-Young）→湿球（Stull 2011）→自然湿球・黒球→WBGT合成の連鎖に置き換え、
 * 湿度・風速が結果に効くようになった。日陰率は従来どおり影多角形の面積比（v4の
 * 二値マッピングより細かい）。ゾーン特性の加算（滞留+1.1 / ゲート+0.6）はv4を踏襲。
 */
function wbgtFrom(zone: Zone, s: Scenario, sunAltDeg: number, shade: number): number {
  const w = wbgtPhysical(shade, Math.max(sunAltDeg, 0), {
    weather: s.weather,
    taC: s.temp,
    rhPct: s.rhPct,
    windMs: s.windMs,
  }).wbgt;
  const adjusted = w + (zone.kind === "queue" ? 1.1 : 0) + (zone.kind === "gate" ? 0.6 : 0);
  return Math.round(adjusted * 10) / 10;
}

export function wbgt(zone: Zone, hour: number, s: Scenario): number {
  const sun = sunAt(hour, s.date, s.geo);
  return wbgtFrom(zone, s, sun.altitudeDeg, shadeFraction(zone, hour, undefined, s.date, s.geo));
}

export const gateWaitMin = (zone: Zone, hour: number, s: Scenario): number =>
  Math.round(5 + density(zone, hour, s) * 0.5);

// ── 集計 ───────────────────────────────────────────────────────────

export function forecastZones(zones: Zone[], hour: number, s: Scenario): ZoneForecast[] {
  // 影の多角形は時刻ごとに1回だけ計算し、全ゾーンで使い回す
  const shadows = shadowsAt(hour, s.date, s.geo);
  const sun = sunAt(hour, s.date, s.geo);

  return zones.map((zone) => {
    const shade = shadeFraction(zone, hour, shadows, s.date, s.geo);
    return {
      zone,
      density: density(zone, hour, s),
      wbgt: wbgtFrom(zone, s, sun.altitudeDeg, shade),
      shadeFraction: shade,
      shaded: shade >= 0.5,
    };
  });
}

export type HourPeak = {
  maxDensity: number;
  maxDensityZone: Zone;
  maxWbgt: number;
  maxWbgtZone: Zone;
  shadeRate: number;
};

export function hourPeak(zones: Zone[], hour: number, s: Scenario): HourPeak {
  const fc = forecastZones(zones, hour, s);
  let d = fc[0];
  let w = fc[0];
  let shade = 0;
  for (const f of fc) {
    if (f.density > d.density) d = f;
    if (f.wbgt > w.wbgt) w = f;
    shade += f.shadeFraction;
  }
  return {
    maxDensity: d.density,
    maxDensityZone: d.zone,
    maxWbgt: w.wbgt,
    maxWbgtZone: w.zone,
    // 面積比の平均。二値の数え上げではないので時間とともに滑らかに動く
    shadeRate: Math.round((shade / fc.length) * 100),
  };
}

export function dayPlan(s: Scenario): DayPlan {
  const all = VENUE.zones;
  let peakDensity = 0;
  let peakDensityZone = all[0];
  let peakDensityHour = VENUE.open;
  let peakWbgt = 0;
  let peakWbgtZone = all[0];
  let peakWbgtHour = VENUE.open;
  let corridorDanger = false;
  let outsideDanger = false;

  for (const h of HOURS) {
    for (const f of forecastZones(all, h, s)) {
      if (f.density > peakDensity) {
        peakDensity = f.density;
        peakDensityZone = f.zone;
        peakDensityHour = h;
      }
      if (f.wbgt > peakWbgt) {
        peakWbgt = f.wbgt;
        peakWbgtZone = f.zone;
        peakWbgtHour = h;
      }
      const isFlow = f.zone.kind === "corridor" || f.zone.kind === "alley";
      if (isFlow && f.density >= 82) {
        corridorDanger = true;
        if (!IN_ZONE_IDS.has(f.zone.id)) outsideDanger = true;
      }
    }
  }

  let water = 1;
  let aid = 1;
  let guide = 2;
  let mist = false;
  let oneway = false;
  let entryControl = false;
  let stationCoord = false;

  if (peakWbgt >= 31) {
    water += 3;
    aid += 2;
    mist = true;
  } else if (peakWbgt >= 28) {
    water += 1;
    aid += 1;
    mist = s.temp >= 32;
  }
  if (peakDensity >= 75) {
    guide += 3;
    oneway = true;
  }
  if (peakDensity >= 90 || corridorDanger) {
    entryControl = true;
    guide += 1;
  }
  if (outsideDanger) {
    stationCoord = true;
    guide += 1;
  }

  // 人時比較：一律に厚く置く従来運用 vs 予報で山谷に配置した場合
  const baselinePersonHours = 34 * HOURS.length;
  const optimizedPersonHours = 22 * HOURS.length + (water + aid + guide) * 4;

  // 日よけテント提案（馬場v4）。30分刻みで日陰率とWBGTを回し、
  // 「WBGT28以上なのに日陰6割未満」の待機ゾーンに必要枚数を出す
  const tentZones = all.filter((z) => (z.queueArea ?? 0) > 0);
  const tentSteps = [];
  for (let m = VENUE.open * 60; m <= VENUE.close * 60; m += 30) {
    const hour = m / 60;
    const sun = sunAt(hour, s.date, s.geo);
    const night = sun.altitudeDeg <= 0.5;
    const shadows = night ? [] : shadowsAt(hour, s.date, s.geo);
    tentSteps.push({
      minutes: m,
      night,
      zones: tentZones.map((z) => {
        const shade = night ? 1 : shadeFraction(z, hour, shadows, s.date, s.geo);
        return { id: z.id, shade, wbgt: wbgtFrom(z, s, sun.altitudeDeg, shade) };
      }),
    });
  }
  const tentResult = tentPlan(
    tentSteps,
    tentZones.map((z) => ({ id: z.id, name: z.name, queueArea: z.queueArea ?? 0 }))
  );
  const tents = {
    total: tentResult.total,
    list: tentResult.list.map((t) => ({
      zoneId: t.zone.id,
      zoneName: t.zone.name,
      need: t.need,
      from: t.from,
      to: t.to,
    })),
  };

  return {
    peakDensity,
    peakDensityHour,
    peakDensityZone,
    peakWbgt,
    peakWbgtHour,
    peakWbgtZone,
    waitMin: Math.round(6 + peakDensity * 0.55),
    water,
    aid,
    guide,
    mist,
    oneway,
    entryControl,
    stationCoord,
    corridorDanger,
    outsideDanger,
    baselinePersonHours,
    optimizedPersonHours,
    savedPercent: Math.round((1 - optimizedPersonHours / baselinePersonHours) * 100),
    tents,
  };
}

export const toPath = (poly: Point[]): string =>
  `${poly.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")}Z`;
