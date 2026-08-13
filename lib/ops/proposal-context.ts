import type { CorrectedZone } from "@/lib/ui/use-nowcast";
import { timetableContext } from "@/lib/data/timetable";
import { ROLE_LABEL, zoneById } from "@/lib/ops/staffing";
import type { Report, Staff } from "@/lib/ops/store";

/**
 * AI配置提案（/api/propose）へ渡す context の組み立て — 純関数化（2026-08-13）。
 *
 * `adjust-console.tsx` の `askProposal` 内にあったcontext構築をそのまま抜き出したもの。
 * **キー名は1文字も変えない**: `/api/propose` のプロンプトがこのキー名（`hour` `timetable`
 * `risky` `現在配置` `直近の報告`、risky内は `zoneId` `zone` `予測` `補正後` `観測あり` `食い違い`）
 * を前提に組まれているため、ここを変えるとAI提案が壊れる。
 */
export function buildProposalContext(
  hour: number,
  corrected: CorrectedZone[],
  staffList: Staff[],
  reports: Report[]
): Record<string, unknown> {
  return {
    hour: `${hour}:00`,
    timetable: timetableContext(hour),
    risky: corrected
      .filter((c) => c.correctedValue >= 60)
      .map((c) => ({
        zoneId: c.zone.id,
        zone: c.zone.name,
        予測: c.predicted,
        補正後: c.correctedValue,
        観測あり: c.observed !== null,
        食い違い: c.conflict,
      })),
    現在配置: staffList.map((s) => ({
      name: s.name,
      post: s.postCode,
      zone: zoneById(s.zoneId)?.name ?? s.zoneId,
      role: ROLE_LABEL[s.role],
      state: s.state,
    })),
    直近の報告: reports.slice(0, 6).map((r) => `${zoneById(r.zoneId)?.name}: ${r.summary}（${r.name}）`),
  };
}
