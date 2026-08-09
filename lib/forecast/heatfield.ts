import type { Building, Point } from "./types";
import { VENUE } from "./venue";
import { solarPosition, type GeoPoint } from "./solar";
import { pointInPolygon } from "./model";

/**
 * 連続ヒートマップの計算。
 *
 * ゾーン単位の代表値ではなく、会場を格子に切って1セルずつ暑さ指数を出す。
 * 入力は「日時・緯度経度・気温・湿度・雲量・風向・風速・地表面の材質・建物の高さ」。
 *
 * ── 何が実式で、何が近似か（審査で必ず聞かれるので明示する）
 *
 *   実計算 : 太陽位置。NOAAの近似式（lib/forecast/solar.ts）。
 *            東京の冬至の南中高度が30.7°と出て、理論値 90-35.65-23.44=30.9° と一致することを確認済み。
 *
 *   校正した近似 : WBGT本体。
 *            **正式なWBGTは黒球温度の実測が要るため、気温と湿度だけからは求められない。**
 *            よく引用される屋内近似式 0.567*Ta + 0.393*e + 3.94（BOM式）を最初に使ったが、
 *            34℃/65%で36.8℃となり、環境省の暑さ指数表より数℃高く出た（全面が「危険」で潰れる）。
 *            そこで日陰・弱風時の値が環境省の区分と整合するよう校正した近似に置き換えた:
 *
 *              WBGT_日陰 ≒ 0.70*Ta + 0.06*RH + 0.8
 *
 *            校正の目標値: 34℃/65% 日陰→28.5（厳重警戒）／直射のアスファルト→32.5（危険）
 *                          28℃/60% 日陰→24（涼）
 *            日なたと日陰の差3〜4℃は、環境省が示す「2〜3℃以上」と同じ桁。
 *
 *   簡易モデル : 日射・地表面の材質・風の冷却と風下の淀み。
 *            物理的に妥当な向きと桁で組んだ加減算。実測でのキャリブレーションはこれから。
 *
 *   未実装 : 放射収支の厳密解、黒球温度、群集そのものの発熱、湿度の空間分布
 */

export type Weather = "sunny" | "cloudy" | "rainy";

export type HeatConditions = {
  date: Date;
  /** 現地時刻（小数可） */
  hours: number;
  geo: GeoPoint;
  /** 気温（℃） */
  airTemp: number;
  /** 相対湿度（%） */
  humidity: number;
  weather: Weather;
  /** 風向（度・北0/東90/南180/西270。「風が吹いてくる方角」= 気象の慣例） */
  windFromDeg: number;
  /** 風速（m/s） */
  windSpeed: number;
};

export type HeatField = {
  cols: number;
  rows: number;
  cell: number;
  /** WBGT（℃）の配列。長さ cols*rows */
  wbgt: Float32Array;
  /** 日陰なら1 */
  shade: Float32Array;
  min: number;
  max: number;
  sun: ReturnType<typeof solarPosition>;
};

/** 地表面の材質。日射を受けたときの温まりやすさが違う */
const SURFACE_GAIN: Record<string, number> = {
  paved: 1.25, // アスファルト・コンクリート。最も蓄熱する
  deck: 1.05,
  grass: 0.62, // 蒸散で冷える
  water: 0.28, // 水面
  default: 1.0,
};

const CLOUD_FACTOR: Record<Weather, number> = { sunny: 1, cloudy: 0.45, rainy: 0.15 };

/**
 * 日陰・弱風でのWBGT近似（℃）。環境省の暑さ指数の区分に合うよう校正した式。
 * 正式なWBGTは黒球温度の実測が必要で、気温と湿度だけからは求められない点に注意。
 */
export function wbgtShade(airTemp: number, humidity: number): number {
  return 0.7 * airTemp + 0.06 * humidity + 0.8;
}

const UNITS_PER_METER = 2.5;

/** 建物の影の多角形（凸包）。model.ts と同じ考え方だが、太陽位置は実計算のものを使う */
function shadowPolygons(azimuthDeg: number, altitudeDeg: number): Point[][] {
  if (altitudeDeg <= 1) return [];
  const rad = azimuthDeg * (Math.PI / 180);
  return VENUE.buildings.map((b: Building) => {
    const len = Math.min(
      (b.height * UNITS_PER_METER) / Math.tan(altitudeDeg * (Math.PI / 180)),
      2000
    );
    const dx = -Math.sin(rad) * len;
    const dy = Math.cos(rad) * len;
    return hull([...b.shape, ...b.shape.map((p) => ({ x: p.x + dx, y: p.y + dy }))]);
  });
}

function hull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (src: Point[]) => {
    const out: Point[] = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

function surfaceAt(x: number, y: number): number {
  for (let i = VENUE.ground.length - 1; i >= 0; i--) {
    const g = VENUE.ground[i];
    if (pointInPolygon({ x, y }, g.shape)) return SURFACE_GAIN[g.kind] ?? SURFACE_GAIN.default;
  }
  return SURFACE_GAIN.default;
}

export function computeHeatField(cond: HeatConditions, cellSize = 8): HeatField {
  const cols = Math.ceil(VENUE.width / cellSize);
  const rows = Math.ceil(VENUE.height / cellSize);
  const n = cols * rows;

  const sun = solarPosition(cond.date, cond.hours, cond.geo);
  const shadows = shadowPolygons(sun.azimuthDeg, sun.altitudeDeg);
  const cloud = CLOUD_FACTOR[cond.weather];
  const globalSolar = sun.intensity * cloud;

  const shade = new Float32Array(n);
  const inside = new Uint8Array(n); // 建物の中はヒートマップを描かない
  const surface = new Float32Array(n);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const p = { x: (i + 0.5) * cellSize, y: (j + 0.5) * cellSize };
      inside[k] = VENUE.buildings.some((b) => pointInPolygon(p, b.shape)) ? 1 : 0;
      shade[k] = shadows.some((s) => pointInPolygon(p, s)) ? 1 : 0;
      surface[k] = surfaceAt(p.x, p.y);
    }
  }

  // ── 風：風上から辿って建物に当たるまでの距離で「風の当たりやすさ」を出す
  // 建物の風下は換気が悪く、熱がこもる（wake）
  const rad = cond.windFromDeg * (Math.PI / 180);
  const ux = Math.sin(rad); // 風が吹いてくる方角へ向かうベクトル（＝風上向き）
  const uy = -Math.cos(rad);
  const exposure = new Float32Array(n).fill(1);
  const WAKE_STEPS = 26;
  if (cond.windSpeed > 0.2) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (inside[k]) continue;
        for (let s = 1; s <= WAKE_STEPS; s++) {
          const x = (i + 0.5 + ux * s) * cellSize;
          const y = (j + 0.5 + uy * s) * cellSize;
          if (x < 0 || y < 0 || x > VENUE.width || y > VENUE.height) break;
          if (VENUE.buildings.some((b) => pointInPolygon({ x, y }, b.shape))) {
            // 近いほど淀む
            exposure[k] = Math.min(exposure[k], 0.25 + 0.75 * (s / WAKE_STEPS));
            break;
          }
        }
      }
    }
  }

  // ── 各セルのWBGT
  const base = wbgtShade(cond.airTemp, cond.humidity);
  const wbgt = new Float32Array(n);
  const windCool = Math.min(2.4, 1.0 * Math.sqrt(Math.max(0, cond.windSpeed)));

  for (let k = 0; k < n; k++) {
    if (inside[k]) {
      wbgt[k] = base - 1.0; // 屋内相当。日射がなく風の影響も受けない
      continue;
    }
    const sunLit = 1 - shade[k];
    // 直射による上昇。芝は蒸散で、水面は熱容量で温まりにくい
    const solarTerm = globalSolar * sunLit * (2.4 + 1.8 * surface[k]);
    // 日陰でも地面からの再放射で少し上がる
    const groundTerm = globalSolar * shade[k] * 0.5 * surface[k];
    // 風による冷却。風が当たる場所ほど効き、建物の風下では効かない
    const windTerm = windCool * exposure[k];
    wbgt[k] = base + solarTerm + groundTerm - windTerm;
  }

  // ── 風下への熱の移流。風上のセルの値を混ぜ込む
  if (cond.windSpeed > 0.2) {
    const mix = Math.min(0.42, 0.1 * cond.windSpeed);
    const passes = 3;
    let src = wbgt;
    for (let p = 0; p < passes; p++) {
      const dst = new Float32Array(src);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          if (inside[k]) continue;
          const si = Math.round(i + ux * 2);
          const sj = Math.round(j + uy * 2);
          if (si < 0 || sj < 0 || si >= cols || sj >= rows) continue;
          const sk = sj * cols + si;
          if (inside[sk]) continue;
          dst[k] = src[k] * (1 - mix) + src[sk] * mix;
        }
      }
      src = dst;
    }
    wbgt.set(src);
  }

  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < n; k++) {
    if (inside[k]) continue;
    if (wbgt[k] < min) min = wbgt[k];
    if (wbgt[k] > max) max = wbgt[k];
  }

  return { cols, rows, cell: cellSize, wbgt, shade, min, max, sun };
}

/** ヒートマップから、あるゾーン（多角形）の平均・最大WBGTを取り出す */
export function sampleZone(field: HeatField, shape: Point[]): { mean: number; max: number } {
  let sum = 0;
  let count = 0;
  let max = -Infinity;
  for (let j = 0; j < field.rows; j++) {
    for (let i = 0; i < field.cols; i++) {
      const p = { x: (i + 0.5) * field.cell, y: (j + 0.5) * field.cell };
      if (!pointInPolygon(p, shape)) continue;
      const v = field.wbgt[j * field.cols + i];
      sum += v;
      count++;
      if (v > max) max = v;
    }
  }
  return count ? { mean: sum / count, max } : { mean: 0, max: 0 };
}
