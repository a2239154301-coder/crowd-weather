"use client";

import { useCallback, useState } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { useScenario } from "@/lib/ui/scenario-context";
import { useNowcast } from "@/lib/ui/use-nowcast";
import { buildProposalContext } from "@/lib/ops/proposal-context";
import { zoneById } from "@/lib/ops/staffing";
import type { Report, Staff } from "@/lib/ops/store";
import SourceTag from "@/components/source-tag";

/**
 * AI配置提案パネル — 「配置」タブへ切り出したAI配置提案の部品（2026-08-13）。
 *
 * 元は adjust-console.tsx の一部だった「観測 → 統合 → 補正 → 提案 → 承認・配信」ループの
 * 最後の2段（提案の起草・人間の承認 → 配信）。配信の入口を配置タブへ一本化するため独立させた。
 * 報告・スタッフのポーリングは親（配置タブ）が持ち、propsで受け取る（自前ポーリングはしない）。
 *
 * 統合・補正は決定的（useNowcast）。LLMは提案の起草だけ（CLAUDE.md改訂ルール）。
 *
 * 注: 写真ナウキャストの採用入口は「調整」コンソール側に残っている（このタスクでは移設対象外）。
 * そのため useNowcast にはphotoObsを渡さない＝この提案はカメラ・スタッフ報告のみを見て起草される
 * （元の adjust-console 内の askProposal も同じ observations/corrected を共有していたため、
 * 写真観測を採用した直後の1回だけは挙動が変わりうる差分。実害は小さいと判断したが、注記しておく）。
 */

export type Proposal = {
  staffName: string;
  fromCode: string;
  toZoneId: string;
  action: string;
  urgency: string;
  reason: string;
};

type Props = {
  hour: number;
  staffList: Staff[];
  reports: Report[];
  /** 承認・配信が成功したときに呼ぶ（親がポーリングを促すため） */
  onApproved?: () => void;
  /** hover/選択された提案のindex。マップ側のハイライトに使う。未選択は null */
  focusedIndex?: number | null;
  onFocusChange?: (index: number | null) => void;
  /** 親が持っている提案を親に見せるため（マップ描画に使う）。提案が更新されたら呼ぶ */
  onProposalsChange?: (proposals: Proposal[]) => void;
};

export default function ProposalPanel({
  hour,
  staffList,
  reports,
  onApproved,
  focusedIndex = null,
  onFocusChange,
  onProposalsChange,
}: Props) {
  const { scenario } = useScenario();
  const { corrected } = useNowcast(hour, scenario, reports);

  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [proposalNote, setProposalNote] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMetaLine, setAiMetaLine] = useState("");

  // ── AI提案 ──
  const askProposal = useCallback(async () => {
    setAiBusy(true);
    setProposals(null);
    setProposalNote("");
    const t0 = Date.now();
    try {
      const context = buildProposalContext(hour, corrected, staffList, reports);
      const res = await fetch("/api/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      const next: Proposal[] = data.proposals ?? [];
      setProposals(next);
      onProposalsChange?.(next);
      setProposalNote(data.note ?? "");
      const served = data.meta?.resolvedModel ?? data.meta?.servedModel ?? "";
      setAiMetaLine(`${served} ／ ${((Date.now() - t0) / 1000).toFixed(1)}s${data.rejected ? ` ／ 範囲外提案${data.rejected}件を棄却` : ""}`);
    } catch {
      setProposalNote("提案を取得できませんでした");
      setProposals([]);
      onProposalsChange?.([]);
    } finally {
      setAiBusy(false);
    }
  }, [hour, corrected, staffList, reports, onProposalsChange]);

  /** 承認 = このボタンだけが配信の入口（AIは提案まで）。連打による重複配信を防ぐ */
  const [approving, setApproving] = useState<Proposal | null>(null);
  async function approve(p: Proposal) {
    if (approving) return;
    setApproving(p);
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProposalNote(`配信できませんでした: ${data?.error ?? res.status}`);
        return;
      }
      const next = proposals ? proposals.filter((x) => x !== p) : proposals;
      setProposals(next);
      onProposalsChange?.(next ?? []);
      onApproved?.();
    } finally {
      setApproving(null);
    }
  }

  function reject(p: Proposal) {
    const next = proposals ? proposals.filter((x) => x !== p) : proposals;
    setProposals(next);
    onProposalsChange?.(next ?? []);
  }

  return (
    <section style={{ ...panel, borderColor: DAY.text, borderWidth: 2 }}>
      <h3 style={{ ...h3, display: "flex", alignItems: "center", gap: 8 }}>
        AI配置提案（承認するまで配信されない）
        <SourceTag kind="ai" tone="day" />
      </h3>
      <button onClick={askProposal} disabled={aiBusy} style={{ width: "100%", minHeight: 52, borderRadius: 10, border: "none", background: aiBusy ? "#93A3C0" : DAY.text, color: "#FFF", fontSize: 15, fontWeight: 700, cursor: aiBusy ? "wait" : "pointer" }}>
        {aiBusy ? "起草中…" : "観測と予報から提案を作る"}
      </button>
      {aiMetaLine && <div className="cw-mono" style={{ fontSize: 13, color: DAY.textFaint, marginTop: 4 }}>{aiMetaLine}</div>}
      {proposalNote && <p style={{ margin: "8px 0 0", fontSize: 13, color: DAY.textDim }}>{proposalNote}</p>}
      {proposals?.map((p, i) => (
        <div
          key={i}
          onMouseEnter={() => onFocusChange?.(i)}
          onMouseLeave={() => onFocusChange?.(null)}
          onFocus={() => onFocusChange?.(i)}
          onBlur={() => onFocusChange?.(null)}
          style={{
            background: "#FFF",
            border: `1px solid ${focusedIndex === i ? DAY.text : DAY.line}`,
            borderRadius: 10,
            padding: "10px 12px",
            marginTop: 8,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {p.fromCode} {p.staffName} → {zoneById(p.toZoneId)?.name ?? p.toZoneId}
            {p.urgency === "now" && <span style={{ marginLeft: 6, color: DAY.danger, fontSize: 13 }}>いますぐ</span>}
          </div>
          <div style={{ fontSize: 13, margin: "2px 0" }}>{p.action}</div>
          <div style={{ fontSize: 13, color: DAY.textFaint }}>{p.reason}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button onClick={() => approve(p)} disabled={approving !== null} style={{ flex: 1, minHeight: 44, borderRadius: 9, border: "none", background: approving ? "#93A3C0" : DAY.text, color: "#FFF", fontWeight: 700, fontSize: 15, cursor: approving ? "wait" : "pointer" }}>
              {approving === p ? "配信中…" : "承認して配信"}
            </button>
            <button onClick={() => reject(p)} style={{ flex: 1, minHeight: 44, borderRadius: 9, border: `1px solid ${DAY.line}`, background: "#FFF", fontSize: 15, cursor: "pointer" }}>
              却下
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

const panel: React.CSSProperties = {
  background: DAY.surface,
  border: `1px solid ${DAY.line}`,
  borderRadius: 12,
  padding: "12px 14px",
};

const h3: React.CSSProperties = { margin: "0 0 8px", fontSize: 15, fontWeight: 700 };
