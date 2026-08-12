import { VENUE } from "@/lib/forecast/venue";
import { mulberry32, noiseFactor } from "./prng";

/**
 * 定点カメラの観測時系列（**架空・デモ用**）。
 *
 * 2026-08-13 新設、同日改訂。「カメラのリモートセンシングで定点の人の多さを測る」前提の
 * デモデータ。実カメラは繋がっていない（実運用では CSRNet 等の群集カウントモデルの
 * 出力がこの型で入る — T2: センシング）。
 *
 * ## 設計改訂（レビュー指摘 2026-08-13）
 *
 * 初版は既定シナリオの予報値を焼き込んだ絶対値を持っていたため、計画タブで
 * チケット数等を変えると「観測（旧条件）×予測（新条件）」の偽の食い違いが
 * 全ゾーンで発生した（実機確認）。現在は**比率（ratio）だけ**を持ち、
 * 絶対値は読み出し時に「そのときのシナリオの予測値 × ratio」で導出する。
 * これで What-if 中もカメラは「概ね予測どおり＋仕込んだ異常」を観測し続ける。
 *
 * ## 生成則（ここに明記）
 *
 * 5分間隔・開場〜終演。ratio = シード付きノイズ(±6%) × 異常注入:
 *   **14:30〜15:10 の西ゲートに想定外の山（最大×1.55・14:50ピーク）**
 *   — 「予報が外れたとき、観測がそれを教え、ナウキャストが補正する」という
 *   調整デモの筋書きそのもの。画面では（デモデータ）表記。
 */

export type CameraRatioFrame = {
  cameraId: string;
  zoneId: string;
  /** 0時からの分 */
  minutes: number;
  /** 予測に対する観測の比率（1.0 ≒ 予測どおり） */
  ratio: number;
};

/** 読み出し時に絶対値化したフレーム */
export type CameraFrame = {
  cameraId: string;
  zoneId: string;
  minutes: number;
  /** カメラ視野内の推定人数 */
  count: number;
  /** 混雑指数0-100換算（ナウキャスト観測に使う） */
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

/** カメラ視野の想定収容人数（指数100のときの人数）。較正定数 */
const CAM_CAPACITY: Record<string, number> = {
  "cam-wg": 220,
  "cam-main": 900,
  "cam-shop": 260,
  "cam-conc": 380,
};

const STEP_MIN = 5;

/** 想定外の山: 西ゲート 14:30-15:10、14:50ピークで最大×1.55 */
function anomalyFactor(cameraId: string, minutes: number): number {
  if (cameraId !== "cam-wg") return 1;
  const peak = 14 * 60 + 50;
  const half = 20;
  const d = Math.abs(minutes - peak);
  if (d > half + 20) return 1;
  const x = Math.max(0, 1 - d / (half + 20));
  return 1 + 0.55 * x * x;
}

function generate(): CameraRatioFrame[] {
  const rand = mulberry32(88130814);
  const frames: CameraRatioFrame[] = [];
  for (let m = VENUE.open * 60; m <= VENUE.close * 60; m += STEP_MIN) {
    for (const cam of CAMERAS) {
      frames.push({
        cameraId: cam.id,
        zoneId: cam.zoneId,
        minutes: m,
        ratio: anomalyFactor(cam.id, m) * noiseFactor(rand, 0.06),
      });
    }
  }
  return frames;
}

/** 全比率フレーム（モジュール読み込み時に決定的に生成。毎回同一） */
export const CAMERA_RATIO_FRAMES: CameraRatioFrame[] = generate();

/**
 * 現在のシナリオでの予測混雑指数を返す関数。呼び出し側（調整コンソール等）が
 * `forecastZones`＋需要整形から作って渡す。camera.ts は予報モデルに依存しない。
 */
export type DensityOf = (zoneId: string, hourFloat: number) => number;

function materialize(f: CameraRatioFrame, densityOf: DensityOf): CameraFrame {
  const predicted = densityOf(f.zoneId, f.minutes / 60);
  const implied = Math.max(0, Math.min(100, Math.round(predicted * f.ratio)));
  return {
    cameraId: f.cameraId,
    zoneId: f.zoneId,
    minutes: f.minutes,
    count: Math.round(((predicted * f.ratio) / 100) * (CAM_CAPACITY[f.cameraId] ?? 200)),
    impliedDensity: implied,
  };
}

/** 指定時刻までの最新フレーム（カメラごと）を現シナリオの絶対値で返す */
export function latestFrames(minutes: number, densityOf: DensityOf): CameraFrame[] {
  const out: CameraFrame[] = [];
  for (const cam of CAMERAS) {
    const mine = CAMERA_RATIO_FRAMES.filter((f) => f.cameraId === cam.id && f.minutes <= minutes);
    if (mine.length > 0) out.push(materialize(mine[mine.length - 1], densityOf));
  }
  return out;
}

/** ゾーンのカメラ実測カーブ（5分分解能・現シナリオの絶対値） */
export function cameraSeries(zoneId: string, densityOf: DensityOf): CameraFrame[] {
  return CAMERA_RATIO_FRAMES.filter((f) => f.zoneId === zoneId).map((f) => materialize(f, densityOf));
}
