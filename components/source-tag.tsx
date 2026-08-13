import { INK } from "@/lib/forecast/scales";
import { DAY } from "@/lib/ui/day-theme";

/**
 * 「この表示はどこから来たか」のラベルチップ（08-13 現場フィードバック対応）。
 *
 * 馬場氏要望は「計算結果を黄色、AI出力をオレンジなど、テキストの色に差をつける」だが、
 * 明色地の文字は必ず墨色という運用ルール（day-theme.ts）と衝突するため、
 * 文字色ではなく **色ドット付きのラベルチップ** で区別する。
 * 黄=計算（LLM不使用）／橙=AI起草。ハルシネーション対策の出所明示が目的。
 */
export default function SourceTag({ kind, tone }: { kind: "calc" | "ai"; tone: "ink" | "day" }) {
  const dot = kind === "calc" ? "#FDE047" : "#FB7A1E";
  const label = kind === "calc" ? "計算（LLM不使用）" : "AI起草・要確認";
  const t = tone === "ink" ? INK : DAY;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 9px",
        borderRadius: 999,
        border: `1px solid ${t.line}`,
        fontSize: 13,
        fontWeight: 600,
        color: tone === "ink" ? INK.textDim : DAY.textDim,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, flex: "none" }} />
      {label}
    </span>
  );
}
