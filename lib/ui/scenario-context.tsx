"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { Scenario } from "@/lib/forecast/types";
import { DEFAULT_SCENARIO } from "@/lib/forecast/venue";

/**
 * Scenario（予報条件）の共有コンテキスト。
 *
 * 2026-08-13 新設。従来は OpsConsole と LiveConsole がそれぞれ
 * `useState<Scenario>(DEFAULT_SCENARIO)` を持っていて、**計画モードで変えた条件が
 * 当日モードに反映されない**という不整合があった（Explore実測で確認）。
 * 計画 → 計画書出力 → 当日 → 調整 が同じ条件を見ることは、
 * 「計画と実際のAdjustment」という製品の主張の前提なので、ここで一本化する。
 *
 * `hour`（表示時刻）は共有しない。計画=シミュレーション時刻・当日=実時刻ベースで
 * 意味が違うため、各ビューが自分で持つ。
 */

type ScenarioContextValue = {
  scenario: Scenario;
  setScenario: React.Dispatch<React.SetStateAction<Scenario>>;
  /** 個別フィールドの更新ヘルパー（ops-console の set() と同じ形） */
  set: <K extends keyof Scenario>(key: K, value: Scenario[K]) => void;
};

const ScenarioContext = createContext<ScenarioContextValue | null>(null);

export function ScenarioProvider({ children }: { children: React.ReactNode }) {
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const value = useMemo<ScenarioContextValue>(
    () => ({
      scenario,
      setScenario,
      set: (key, v) => setScenario((p) => ({ ...p, [key]: v })),
    }),
    [scenario]
  );
  return <ScenarioContext.Provider value={value}>{children}</ScenarioContext.Provider>;
}

export function useScenario(): ScenarioContextValue {
  const ctx = useContext(ScenarioContext);
  if (!ctx) {
    throw new Error("useScenario は ScenarioProvider の内側でしか使えません（app-shell を確認）");
  }
  return ctx;
}
