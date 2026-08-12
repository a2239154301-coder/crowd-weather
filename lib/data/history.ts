import type { Scenario } from "@/lib/forecast/types";
import { forecastZones } from "@/lib/forecast/model";
import { HOURS, VENUE, zonesFor, DEFAULT_SCENARIO } from "@/lib/forecast/venue";
import { mulberry32, noiseFactor } from "./prng";

/**
 * 過去開催の実績データ（**架空・デモ用**）。
 *
 * 2026-08-13 新設。「過去にイベントをした際、どの時間帯にどれくらい人が来たか」を
 * 計画画面で今回予測と重ね描きするためのデータ。
 *
 * ## 生成則（実測に見せかけないため、ここに明記する）
 *
 * 過去2回分を、**現行の予報エンジンにその回の条件を入れた出力 × シード付きノイズ**で作る:
 *   実績値 = forecastZones(その回のscenario) × (1 ± 8%の一様ノイズ) × 回ごとの系統差
 * 系統差は「2024年は雨上がりで出足が遅い（前半-15%）」のような回ごとの物語を1つずつ入れ、
 * 単なるノイズ違いではなく「年によって形が違う」ことが見えるようにしている。
 *
 * 画面では必ず「デモデータ」と表記する。実運用では入退場ゲートログ・チケットもぎり実績が
 * この型に入る（T0: 事前に手に入る過去実績）。
 */

export type HistoryEdition = {
  /** 表示名（例 "2024年（第1回）曇・22,000枚"） */
  label: string;
  scenario: Scenario;
  /** ゾーンID → 時刻順の混雑指数（HOURS と同じ並び） */
  zoneDensity: Record<string, number[]>;
  /** 時刻順のゲート流入（人/時。会場全体） */
  gateInflow: number[];
};

function makeEdition(
  label: string,
  seed: number,
  scenario: Scenario,
  /** 時刻ごとの系統差倍率（HOURSと同じ並び。出足の遅れ等の物語を入れる） */
  systematic: (hourIndex: number) => number
): HistoryEdition {
  const rand = mulberry32(seed);
  const zones = zonesFor("in");
  const zoneDensity: Record<string, number[]> = {};
  for (const z of zones) zoneDensity[z.id] = [];
  const gateInflow: number[] = [];

  HOURS.forEach((h, i) => {
    const fc = forecastZones(zones, h, scenario);
    for (const f of fc) {
      const v = f.density * systematic(i) * noiseFactor(rand, 0.08);
      zoneDensity[f.zone.id].push(Math.max(0, Math.min(100, Math.round(v))));
    }
    // ゲート流入: チケット枚数を在場率の増分で按分した近似 ＋ ノイズ
    const gateAvg = fc.filter((f) => f.zone.kind === "gate");
    const gd = gateAvg.reduce((a, f) => a + f.density, 0) / Math.max(1, gateAvg.length);
    gateInflow.push(Math.round((gd / 100) * (scenario.tickets / 4) * systematic(i) * noiseFactor(rand, 0.1)));
  });

  return { label, scenario, zoneDensity, gateInflow };
}

/** 2024年・第1回（架空）: 曇・22,000枚。雨上がりで出足が遅く、前半が薄い */
const EDITION_2024 = makeEdition(
  "2024年 第1回（曇・22,000枚）",
  20240808,
  { ...DEFAULT_SCENARIO, weather: "cloudy", temp: 30, tickets: 22000, date: { y: 2024, mo: 8, d: 10, label: "8/10" } },
  (i) => (i <= 2 ? 0.85 : 1.0)
);

/** 2025年・第2回（架空）: 晴・26,000枚。ヘッドライナー人気で夜が濃い */
const EDITION_2025 = makeEdition(
  "2025年 第2回（晴・26,000枚）",
  20250809,
  { ...DEFAULT_SCENARIO, weather: "sunny", temp: 35, tickets: 26000, date: { y: 2025, mo: 8, d: 9, label: "8/9" } },
  (i) => (i >= 7 ? 1.12 : 1.0)
);

export const HISTORY: HistoryEdition[] = [EDITION_2024, EDITION_2025];

/** ゾーンの過去実績カーブ（HOURS並び）。過去実績重ね描きチャート用 */
export function historyCurves(zoneId: string): { label: string; values: number[] }[] {
  return HISTORY.filter((e) => e.zoneDensity[zoneId]).map((e) => ({
    label: e.label,
    values: e.zoneDensity[zoneId],
  }));
}

export const HISTORY_ZONE_IDS = Object.keys(HISTORY[0]?.zoneDensity ?? {});
export { VENUE as HISTORY_VENUE };
