"use client";

import { DAY } from "@/lib/ui/day-theme";
import { timeBand, type ZoneRisk } from "@/lib/forecast/risk";
import { evidenceLabel, evidencePlain } from "@/lib/forecast/evidence";
import SourceTag from "./source-tag";

/**
 * 危険の到来順リスト。
 *
 * 2026-08-13、ops-console から切り出して ZoneTimeline 直下に常設した
 * （馬場氏要望: 「危険の到来順を、ZONE TIMELINEの欄内下側に入れる」。
 * 従来は riskレイヤー選択時のみ表示で、混雑/暑熱レイヤーでは見えなかった）。
 * 物理的な意味は平易語（evidencePlain）を主に、技術表記は title で残す。
 */
export default function ArrivalList({ arrivals, hour }: { arrivals: ZoneRisk[]; hour: number }) {
  if (arrivals.length === 0) {
    return (
      <div
        style={{
          background: DAY.surface,
          border: `1px solid ${DAY.line}`,
          borderRadius: 12,
          padding: "14px 16px",
          fontSize: 13,
          color: DAY.textDim,
        }}
      >
        {hour}:00 以降、終演まで危険帯に達するゾーンはありません。
      </div>
    );
  }
  return (
    <div style={{ background: DAY.surface, border: `1px solid ${DAY.line}`, borderRadius: 12, padding: "13px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontSize: 13, letterSpacing: 1, color: DAY.textFaint }}>
          危険の到来順（{hour}:00 以降）
        </span>
        <SourceTag kind="calc" tone="day" />
      </div>
      {arrivals.map((r) => {
        const band = timeBand(r.hoursToDanger);
        const now = r.hoursToDanger === 0;
        return (
          <div
            key={r.zone.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              minHeight: 44,
              borderBottom: `1px solid ${DAY.hairline}`,
            }}
          >
            {/* 段階色は左のドットにのみ使う（明色地の文字は墨色。day-theme.ts冒頭の規約）。
                「いま」の強調は語が担い、色はここでは繰り返さない
                （2026-08-14、馬場氏レビュー項目10で太字を外した） */}
            <span style={{ width: 10, height: 10, borderRadius: 3, background: band.color, flex: "none" }} />
            <span className="cw-mono" style={{ width: 54, fontSize: 15, color: DAY.text, fontWeight: 400 }}>
              {now ? "いま" : `${r.dangerHour}:00`}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 400 }}>{r.zone.name}</span>
            <span style={{ fontSize: 13, color: DAY.textDim }}>{r.dangerCause ?? "—"}</span>
            {/* 物理的な意味（evidence.ts の較正）。平易語を主に、技術表記は title に残す */}
            <span
              title={evidenceLabel(r.zone.kind, r.dangerDensity ?? r.density)}
              style={{ fontSize: 13, color: DAY.textFaint, whiteSpace: "nowrap" }}
            >
              {evidencePlain(r.zone.kind, r.dangerDensity ?? r.density)}
            </span>
            {/* 危険になる「その時刻」の予報値。いまの値ではない */}
            <span className="cw-mono" style={{ width: 118, textAlign: "right", fontSize: 13, color: DAY.textDim }}>
              混{r.dangerDensity} / WBGT{r.dangerWbgt}
            </span>
          </div>
        );
      })}
    </div>
  );
}
