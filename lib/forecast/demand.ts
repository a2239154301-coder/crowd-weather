import type { Zone } from "./types";
import { TIMETABLE, actAt, isIntermission } from "@/lib/data/timetable";

/**
 * 需要整形 — タイムテーブルからゾーン別の需要倍率を作る層。
 *
 * 2026-08-13 新設。`density()`（model.ts・テスト固定領域）には触れず、
 * その出力に掛ける倍率をタイムテーブルから決定的に計算する。
 * ナウキャスト観測（nowcast.ts）と同じ「上に重ねる」設計で、
 * 既存の計算層とテスト33件を無改変に保つ。
 *
 * 倍率の設計（現場の定説をそのまま式にしたもの）:
 *  - 演目中のステージ: 1 + 0.5×draw（ヘッドライナーで1.5倍）
 *  - 幕間: 物販・トイレ・フードが 1.35倍（観客が一斉に動く）、ステージは 0.6倍
 *  - サブステージ演目中: サブ会場 1 + 0.6×draw（屋内なので伸び幅を大きめに）
 * 係数は較正定数（実測代替。実運用ではゲートログ・カメラで較正する）。
 */

export type DemandFactor = {
  zoneId: string;
  factor: number;
  /** 画面・AI文脈に出す理由（「ヘッドライナー開演中」等） */
  reason: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** その時刻のゾーン別需要倍率。倍率1のゾーンは返さない */
export function demandFactors(hour: number): DemandFactor[] {
  const out: DemandFactor[] = [];
  const main = actAt("main", hour);
  const sub = actAt("sub", hour);
  const inter = isIntermission(hour);

  if (main) {
    out.push({
      zoneId: "main",
      factor: 1 + 0.5 * main.draw,
      reason: `${main.act} 開演中（集客力${Math.round(main.draw * 100)}%）`,
    });
  }
  if (sub) {
    out.push({
      zoneId: "sub",
      factor: 1 + 0.6 * sub.draw,
      reason: `${sub.act} 開演中`,
    });
  }
  if (inter) {
    for (const zoneId of ["shop", "food", "wc"]) {
      out.push({ zoneId, factor: 1.35, reason: "幕間（観客が一斉に移動）" });
    }
    out.push({ zoneId: "main", factor: 0.6, reason: "幕間（ステージから流出）" });
  }
  return out;
}

/**
 * 需要倍率を混雑指数に適用する。0-100へクランプ。
 * `zoneRisks()` 側からオプションで呼ばれる。
 */
export function applyDemand(zone: Zone, density: number, hour: number): number {
  const f = demandFactors(hour).find((d) => d.zoneId === zone.id);
  if (!f) return density;
  return clamp(Math.round(density * f.factor), 0, 100);
}

/** タイムテーブルの妥当性（テストで使う）: 同一ステージで演目が重ならない */
export function hasOverlap(): boolean {
  for (const s of ["main", "sub"] as const) {
    const items = TIMETABLE.filter((x) => x.stage === s).sort((a, b) => a.from - b.from);
    for (let i = 1; i < items.length; i++) {
      if (items[i].from < items[i - 1].to) return true;
    }
  }
  return false;
}
