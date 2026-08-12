"use client";

import { DAY } from "@/lib/ui/day-theme";

/**
 * 調整コンソール — 計画と実際のAdjustmentを行う司令塔（当日モード「調整」ビュー）。
 *
 * B工程（スタッフ縦串）で実装する。ここは画面骨格のプレースホルダ。
 * 実装内容: 報告フィード／配置ボード（ポストコード・状態・手動補正）／
 * 計画vs実際の分析チャート／AI提案→承認→配信。
 */
export default function AdjustConsole() {
  return (
    <div
      style={{
        background: DAY.page,
        color: DAY.textDim,
        borderRadius: 16,
        border: `1px solid ${DAY.line}`,
        padding: 24,
        fontSize: 14,
        lineHeight: 1.8,
      }}
    >
      調整コンソール（実装中）— スタッフ報告の受信・配置ボード・AI提案の承認と配信がここに入ります。
    </div>
  );
}
