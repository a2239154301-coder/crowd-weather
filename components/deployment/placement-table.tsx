"use client";

import { useMemo } from "react";
import { DAY } from "@/lib/ui/day-theme";
import { ROSTER, type RosterGroup, type RosterMember } from "@/lib/data/roster";
import { ROLE_LABEL, zoneById, type PostRole } from "@/lib/ops/staffing";
import { vacantPostsOf, unassignedMembers, type DeploymentPlan, type Placement } from "@/lib/ops/deployment";
import type { useDragToMap } from "@/lib/ui/use-drag-to-map";

/**
 * 人員配置エディタ — 下部の表（駒箱 + 割当済み）。
 *
 * 2026-08-14 新設。⚠ このファイルはキーボード操作の唯一の経路である。
 * `venue-map.tsx` のスタッフ `<g>` には `tabIndex`/`role` が無く、会場図だけでは
 * 配置変更が一切できない。行の `<select>` が「空席のみ選べる／未割当に戻せる」ドラッグの
 * 等価な経路であり、これがアクセシビリティの契約そのもの。装飾に縮退させないこと。
 *
 * 上段=未割当レーン（駒箱・ROSTER順）、下段=割当済み（班ごと・ROSTER順で安定化）。
 * 行は `role="button" tabIndex={0}` + Enter/Space で選択（会場図の駒ハイライトに繋がる）。
 * `drag.rowHandlers(name)` を無改造で展開し、行から会場図へのD&Dも両立させる
 * （タップ操作の逃げ道として `<select>` を必ず残す設計と両輪）。
 */

const GROUP_ORDER: RosterGroup[] = ["メイン", "フード", "サブ", "給水", "救護", "受付", "遊軍"];

/** 役割ごとの色（venue-map.tsx のROLE_COLORと同じ値。ファイルをまたいだ共有はしない既存の流儀に合わせる） */
const ROLE_COLOR: Record<PostRole, string> = {
  water: "#38BDF8",
  guide: "#FDE047",
  aid: "#22C55E",
  reception: "#C4B5FD",
};

/** 8列のグリッド定義。横幅が足りない端末は親コンテナの overflow-x:auto に任せる */
const ROW_GRID = "14px minmax(64px,1fr) 46px 46px 60px minmax(88px,1fr) 96px minmax(170px,220px)";
const ROW_MIN_WIDTH = 680;

type RowDragProps = ReturnType<ReturnType<typeof useDragToMap>["rowHandlers"]>;

type Props = {
  plan: DeploymentPlan;
  selectedName: string | null;
  onSelect: (name: string) => void;
  /** toPostCode==="" は「未割当に戻す」 */
  onMove: (name: string, toPostCode: string) => void;
  dragRowHandlers: (name: string) => RowDragProps;
  draggingName: string | null;
  /** 確定済み計画の閲覧時など、操作を止めたいとき */
  disabled?: boolean;
};

export default function PlacementTable({
  plan,
  selectedName,
  onSelect,
  onMove,
  dragRowHandlers,
  draggingName,
  disabled = false,
}: Props) {
  const vacant = useMemo(() => vacantPostsOf(plan), [plan]);
  const placementByName = useMemo(() => new Map(plan.placements.map((p) => [p.name, p])), [plan]);
  const unassigned = useMemo(() => unassignedMembers(ROSTER, plan), [plan]);

  const assignedByGroup: [RosterGroup, { member: RosterMember; placement: Placement }[]][] = useMemo(() => {
    const map = new Map<RosterGroup, { member: RosterMember; placement: Placement }[]>();
    for (const m of ROSTER) {
      const placement = placementByName.get(m.name);
      if (!placement) continue;
      const arr = map.get(m.group) ?? [];
      arr.push({ member: m, placement });
      map.set(m.group, arr);
    }
    const ordered: [RosterGroup, { member: RosterMember; placement: Placement }[]][] = [];
    for (const g of GROUP_ORDER) {
      const arr = map.get(g);
      if (arr && arr.length > 0) ordered.push([g, arr]);
    }
    return ordered;
  }, [placementByName]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ── 駒箱（未割当） ── */}
      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: DAY.text }}>
          未割当（駒箱） <span className="cw-mono">{unassigned.length}</span>名
        </h3>
        {unassigned.length === 0 ? (
          <div style={{ fontSize: 13, color: DAY.textFaint }}>全員が配置済みです</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: ROW_MIN_WIDTH, display: "grid", gap: 4 }}>
              <HeaderRow />
              {unassigned.map((m) => (
                <Row
                  key={m.id}
                  member={m}
                  placement={undefined}
                  vacant={vacant}
                  selected={selectedName === m.name}
                  onSelect={onSelect}
                  onMove={onMove}
                  dragProps={dragRowHandlers(m.name)}
                  dragging={draggingName === m.name}
                  disabled={disabled}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── 割当済み（班ごと） ── */}
      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: DAY.text }}>
          割当済み <span className="cw-mono">{plan.placements.length}</span>名 ／ 空席{" "}
          <span className="cw-mono">{vacant.length}</span>
        </h3>
        {assignedByGroup.length === 0 ? (
          <div style={{ fontSize: 13, color: DAY.textFaint }}>まだ誰も配置されていません</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: ROW_MIN_WIDTH, display: "grid", gap: 10 }}>
              {assignedByGroup.map(([group, rows]) => (
                <div key={group} style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DAY.textDim }}>{group}</div>
                  <HeaderRow />
                  {rows.map(({ member, placement }) => (
                    <Row
                      key={member.id}
                      member={member}
                      placement={placement}
                      vacant={vacant}
                      selected={selectedName === member.name}
                      onSelect={onSelect}
                      onMove={onMove}
                      dragProps={dragRowHandlers(member.name)}
                      dragging={draggingName === member.name}
                      disabled={disabled}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function HeaderRow() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: ROW_GRID,
        gap: 8,
        alignItems: "center",
        padding: "0 10px",
        fontSize: 11,
        fontWeight: 700,
        color: DAY.textFaint,
      }}
      aria-hidden
    >
      <span />
      <span>氏名</span>
      <span>役割</span>
      <span>班</span>
      <span>現ポスト</span>
      <span>ゾーン</span>
      <span>時間帯</span>
      <span>操作</span>
    </div>
  );
}

function Row({
  member,
  placement,
  vacant,
  selected,
  onSelect,
  onMove,
  dragProps,
  dragging,
  disabled,
}: {
  member: RosterMember;
  placement: Placement | undefined;
  vacant: ReturnType<typeof vacantPostsOf>;
  selected: boolean;
  onSelect: (name: string) => void;
  onMove: (name: string, toPostCode: string) => void;
  dragProps: RowDragProps;
  dragging: boolean;
  disabled: boolean;
}) {
  const zoneName = placement ? (zoneById(placement.zoneId)?.name ?? placement.zoneId) : "—";
  const timeRange = placement ? `${placement.fromHour}:00–${placement.toHour}:00` : "—";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${member.name}（${ROLE_LABEL[member.role]}・${placement ? placement.postCode : "未割当"}）`}
      onClick={() => onSelect(member.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(member.name);
        }
      }}
      onPointerDown={dragProps.onPointerDown}
      onContextMenu={dragProps.onContextMenu}
      style={{
        display: "grid",
        gridTemplateColumns: ROW_GRID,
        gap: 8,
        alignItems: "center",
        minHeight: 44,
        padding: "6px 10px",
        borderRadius: 9,
        border: selected ? `2px solid ${DAY.text}` : `1px solid ${DAY.line}`,
        background: DAY.surface,
        cursor: "pointer",
        opacity: dragging ? 0.4 : 1,
        ...dragProps.style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: ROLE_COLOR[member.role],
          justifySelf: "center",
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 700, color: DAY.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {member.name}
      </span>
      <span style={{ fontSize: 13, color: DAY.textDim }}>{ROLE_LABEL[member.role]}</span>
      <span style={{ fontSize: 13, color: DAY.textDim }}>{member.group}</span>
      <span className="cw-mono" style={{ fontSize: 13, color: DAY.text, fontWeight: placement ? 700 : 400 }}>
        {placement ? placement.postCode : "—"}
      </span>
      <span style={{ fontSize: 13, color: DAY.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {zoneName}
      </span>
      <span className="cw-mono" style={{ fontSize: 13, color: DAY.textFaint }}>
        {timeRange}
      </span>
      <select
        value={placement ? placement.postCode : ""}
        aria-label={`${member.name}の配置先ポスト`}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onMove(member.name, e.target.value)}
        style={{
          minHeight: 40,
          borderRadius: 8,
          border: `1px solid ${DAY.line}`,
          padding: "0 8px",
          fontSize: 13,
          color: DAY.text,
          background: "#FFFFFF",
          width: "100%",
        }}
      >
        {placement ? (
          <option value={placement.postCode}>{placement.postCode}（現在）</option>
        ) : (
          <option value="" disabled>
            配置先を選択
          </option>
        )}
        {vacant.map((p) => (
          <option key={p.code} value={p.code}>
            {p.code}（{p.zoneName}）
          </option>
        ))}
        {placement && <option value="">— 未割当に戻す —</option>}
      </select>
    </div>
  );
}
