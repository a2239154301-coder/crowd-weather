import { forecastZones } from "@/lib/forecast/model";
import { DEFAULT_SCENARIO, VENUE } from "@/lib/forecast/venue";
import { applyDemand } from "@/lib/forecast/demand";
import { zoneById } from "@/lib/ops/staffing";
import { mulberry32, noiseFactor } from "./prng";

/**
 * 定点カメラの人数時系列（**架空・デモ用**）。
 *
 * 2026-08-13 新設。「カメラのリモートセンシングで定点の人の多さを測る」前提の
 * デモデータ。実カメラは繋がっていない（実運用では CSRNet 等の群集カウントモデルの
 * 出力がこの型で入る — T2: センシング）。
 *
 * ## 生成則（ここに明記）
 *
 * 5分間隔・開場〜終演。基準値は**当日想定条件の予報エンジン出力**（需要整形込み）を
 * 時刻間で線形補間したもの。そこに:
 *   1. シード付きノイズ ±6%
 *   2. **14:30〜15:10 の西ゲートに想定外の山（最大×1.55・14:50ピーク）**を注入
 *      — 「予報が外れたとき、観測がそれを教え、ナウキャストが補正する」という
 *      調整デモの筋書きそのもの。画面では（デモデータ）表記
 *
 * countは「カメラ視野内の人数」の想定値。密度指数への換算はゾーン面積比の
 * 較正定数（CAM_CAPACITY）による。
 */

export type CameraFrame = {
  cameraId: string;
  zoneId: string;
  /** 0時からの分 */
  minutes: number;
  /** カメラ視野内の推定人数 */
  count: number;
  /** countを混雑指数0-100に換算した値（ナウキャスト観測に使う） */
  impliedDensity: number;
};

export type Camera = { id: string; name: string; zoneId: string };

/** 定点カメラ4台（架空）。実在の警備計画を模さないよう主要動線のみ */
export const CAMERAS: Camera[] = [
  { id: "cam-wg", name: "カメラ1 西ゲート", zoneId: "wg" },
  { id: "cam-main", name: "カメラ2 メインステージ北", zoneId: "main" },
  { id: "cam-shop", name: "カメラ3 物販の列", zoneId: "shop" },
  { id: "cam-conc", name: "カメラ4 改札コンコース", zoneId: "conc" },
];

/** カメラ視野の想定収容人数（count = 指数100のときの人数）。較正定数 */
const CAM_CAPACITY: Record<string, number> = {
  "cam-wg": 220,
  "cam-main": 900,
  "cam-shop": 260,
  "cam-conc": 380,
};

const STEP_MIN = 5;

// 時刻→ゾーン別密度のメモ（生成は1回きりだが、5分×4台で同じ時刻を何度も引くため）
const hourlyCache = new Map<number, Map<string, number>>();
function densityByHour(h: number): Map<string, number> {
  let m = hourlyCache.get(h);
  if (!m) {
    m = new Map(forecastZones(VENUE.zones, h, DEFAULT_SCENARIO).map((f) => [f.zone.id, f.density]));
    hourlyCache.set(h, m);
  }
  return m;
}

function densityAt(zoneId: string, hourFloat: number): number {
  // 時刻間は線形補間（5分刻みのカメラに1時間刻みの予報を合わせる）
  const h0 = Math.floor(hourFloat);
  const h1 = Math.min(VENUE.close, h0 + 1);
  const t = hourFloat - h0;
  const z = zoneById(zoneId);
  if (!z) return 0;
  const d0 = densityByHour(h0).get(zoneId) ?? 0;
  const d1 = densityByHour(h1).get(zoneId) ?? 0;
  const base = d0 * (1 - t) + d1 * t;
  return applyDemand(z, base, hourFloat);
}

/** 想定外の山: 西ゲート 14:30-15:10、14:50ピークで最大×1.55 */
function anomalyFactor(cameraId: string, minutes: number): number {
  if (cameraId !== "cam-wg") return 1;
  const peak = 14 * 60 + 50;
  const half = 20; // 山の半幅（分）
  const d = Math.abs(minutes - peak);
  if (d > half + 20) return 1;
  const x = Math.max(0, 1 - d / (half + 20));
  return 1 + 0.55 * x * x;
}

function generate(): CameraFrame[] {
  const rand = mulberry32(88130814);
  const frames: CameraFrame[] = [];
  for (let m = VENUE.open * 60; m <= VENUE.close * 60; m += STEP_MIN) {
    for (const cam of CAMERAS) {
      const base = densityAt(cam.zoneId, m / 60);
      const withAnomaly = Math.min(115, base * anomalyFactor(cam.id, m) * noiseFactor(rand, 0.06));
      const implied = Math.max(0, Math.min(100, Math.round(withAnomaly)));
      frames.push({
        cameraId: cam.id,
        zoneId: cam.zoneId,
        minutes: m,
        count: Math.round((withAnomaly / 100) * (CAM_CAPACITY[cam.id] ?? 200)),
        impliedDensity: implied,
      });
    }
  }
  return frames;
}

/** 全フレーム（モジュール読み込み時に決定的に生成。毎回同一） */
export const CAMERA_FRAMES: CameraFrame[] = generate();

/** 指定時刻までの最新フレーム（カメラごと）。調整コンソールの「いまの実測」表示用 */
export function latestFrames(minutes: number): CameraFrame[] {
  const out: CameraFrame[] = [];
  for (const cam of CAMERAS) {
    const mine = CAMERA_FRAMES.filter((f) => f.cameraId === cam.id && f.minutes <= minutes);
    if (mine.length > 0) out.push(mine[mine.length - 1]);
  }
  return out;
}

/** ゾーンのカメラ実測カーブ（分解能5分）。分析チャート用 */
export function cameraSeries(zoneId: string): CameraFrame[] {
  return CAMERA_FRAMES.filter((f) => f.zoneId === zoneId);
}
