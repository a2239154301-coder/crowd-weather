import { DAY } from "@/lib/ui/day-theme";
import { INK } from "@/lib/forecast/scales";
import type { SyncStatus } from "@/lib/ui/use-polling";

/** 通信状態の小さな表示。tone は画面の地色に合わせる（当日系=day / 計画系=ink） */
export default function SyncBadge({ sync, tone }: { sync: SyncStatus; tone: "day" | "ink" }) {
  const t = tone === "day" ? DAY : INK;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 13,
        color: sync.ok ? t.textFaint : "#B45309",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: sync.ok ? "#22C55E" : "#B45309",
          flex: "none",
        }}
      />
      {sync.label}
    </span>
  );
}
