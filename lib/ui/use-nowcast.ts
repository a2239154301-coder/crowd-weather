"use client";

import { useMemo } from "react";
import type { Scenario, Zone } from "@/lib/forecast/types";
import { forecastZones } from "@/lib/forecast/model";
import { VENUE } from "@/lib/forecast/venue";
import { applyDemand } from "@/lib/forecast/demand";
import { fuseObservations, correctionFactor, correctedDensity, type Observation } from "@/lib/forecast/nowcast";
import { latestFrames } from "@/lib/data/camera";
import type { Report } from "@/lib/ops/store";

/**
 * ナウキャスト層のReactフック — 観測の組み立てと予測の補正を1つにまとめる。
 *
 * 2026-08-13 新設。`adjust-console.tsx` にあった `densityOf` / `observations` / `corrected` の
 * 3つの useMemo をロジックを変えずに移設したもの（配置タブへ「AI配置提案」を切り出すにあたり、
 * 提案パネル側でも同じ観測・補正が要るため、コンソール専用のローカル状態から共有フックへ格上げした）。
 *
 * 統合・補正は決定的（このファイル自体はLLM不使用）。LLMは報告の構造化と提案起草だけ（CLAUDE.md改訂ルール）。
 */

/** photoObs省略時の既定値。呼び出しごとに新しい配列を作るとuseMemoが毎回無効化されるため、モジュールで固定して参照を安定させる */
const NO_PHOTO_OBS: Observation[] = [];

/** 予測 × 観測補正の1ゾーン分。旧 `corrected` useMemo の要素の推論型を明示的に起こしたもの */
export type CorrectedZone = {
  zone: Zone;
  predicted: number;
  observed: number | null;
  conflict: boolean;
  correctedValue: number;
  factor: number;
};

export function useNowcast(
  hour: number,
  scenario: Scenario,
  reports: Report[],
  photoObs: Observation[] = NO_PHOTO_OBS
): { observations: Observation[]; corrected: CorrectedZone[]; densityOf: (zoneId: string, hourFloat: number) => number } {
  const nowMinutes = hour * 60;

  // カメラの絶対値化に使う「現シナリオの予測」関数（時刻間は線形補間・時刻ごとにメモ）
  const densityOf = useMemo(() => {
    const cache = new Map<number, Map<string, number>>();
    const byHour = (h: number) => {
      let m = cache.get(h);
      if (!m) {
        m = new Map(
          forecastZones(VENUE.zones, h, scenario).map((f) => [
            f.zone.id,
            applyDemand(f.zone, f.density, h),
          ])
        );
        cache.set(h, m);
      }
      return m;
    };
    return (zoneId: string, hourFloat: number) => {
      const h0 = Math.max(VENUE.open, Math.floor(hourFloat));
      const h1 = Math.min(VENUE.close, h0 + 1);
      const t = hourFloat - h0;
      const d0 = byHour(h0).get(zoneId) ?? 0;
      const d1 = byHour(h1).get(zoneId) ?? 0;
      return d0 * (1 - t) + d1 * t;
    };
  }, [scenario]);

  // ── 観測の組み立て（カメラ=デモデータ・報告=store） ──
  const observations = useMemo<Observation[]>(() => {
    const obs: Observation[] = latestFrames(nowMinutes, densityOf).map((f) => ({
      zoneId: f.zoneId,
      minutes: f.minutes,
      impliedDensity: f.impliedDensity,
      source: "camera" as const,
    }));
    // スタッフ報告: 1-5 → 指数換算（1→15 / 2→35 / 3→55 / 4→75 / 5→95）。crowd系のみ密度観測になる
    for (const r of reports) {
      if (r.kind !== "crowd") continue;
      obs.push({
        zoneId: r.zoneId,
        minutes: nowMinutes, // 報告は「いま」の観測として扱う（デモは実時刻とシミュ時刻が混ざるため）
        impliedDensity: 15 + (r.level - 1) * 20,
        source: r.source,
      });
    }
    // 写真観測（人間が「採用」したものだけ）
    for (const p of photoObs) obs.push(p);
    return obs;
  }, [nowMinutes, reports, densityOf, photoObs]);

  // ── 予測と補正（決定的） ──
  const zones = VENUE.zones;
  const corrected = useMemo(() => {
    const fc = forecastZones(zones, hour, scenario);
    return fc.map((f) => {
      const withDemand = applyDemand(f.zone, f.density, hour);
      const fusion = fuseObservations(observations, f.zone.id, nowMinutes);
      const age = fusion.latestMinutes === null ? Infinity : nowMinutes - fusion.latestMinutes;
      const factor = correctionFactor(fusion.fusedDensity, withDemand, age === Infinity ? 999 : age);
      return {
        zone: f.zone,
        predicted: withDemand,
        observed: fusion.fusedDensity,
        conflict: fusion.conflict,
        correctedValue: correctedDensity(withDemand, factor),
        factor,
      };
    });
  }, [zones, hour, scenario, observations, nowMinutes]);

  return { observations, corrected, densityOf };
}
