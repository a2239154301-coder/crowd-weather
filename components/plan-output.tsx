"use client";

import { useMemo } from "react";
import { useScenario } from "@/lib/ui/scenario-context";
import { dayPlan } from "@/lib/forecast/model";
import { postsFor, postsToMarks } from "@/lib/ops/staffing";
import { INK } from "@/lib/forecast/scales";
import SecurityPlan from "./security-plan";

/**
 * 「計画書出力」タブ — レポートを出す場所を独立させたもの（2026-08-13 画面構成再編）。
 *
 * 従来は予報コンソールの最下部にトグルで埋まっていて、
 * 「計画を作る場所」と「文書を出す場所」が混ざっていた。
 * 条件は ScenarioProvider 経由で予報コンソールと同一（このタブで数字がズレることはない）。
 */
export default function PlanOutput() {
  const { scenario } = useScenario();
  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const staff = useMemo(() => postsToMarks(postsFor(plan)), [plan]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: INK.textDim,
          lineHeight: 1.8,
          maxWidth: 780,
        }}
      >
        予報コンソールで設定した条件（{scenario.date.label}・{scenario.weather === "sunny" ? "晴" : scenario.weather === "cloudy" ? "曇" : "雨"}・
        {scenario.temp}℃・{scenario.tickets.toLocaleString()}枚）から、そのまま提出できる
        雑踏警備計画書を生成します。配置図のマークには配置ポストのコード（A-1等）が入り、
        当日モードの指示と同じ語彙で読めます。総括はAIが起草し、印刷 / PDF保存で手元に残ります。
      </p>
      <SecurityPlan scenario={scenario} plan={plan} staff={staff} />
    </div>
  );
}
