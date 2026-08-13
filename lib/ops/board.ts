import type { Point } from "@/lib/forecast/types";
import { centroid } from "@/lib/forecast/model";
import { zoneById, type Post, type PostRole } from "./staffing";
import type { Dispatch, Staff } from "./store";

/**
 * 配置ボード（メンバーリスト×マップ）の純関数層。
 *
 * 2026-08-13 新設。旧 `adjust-console.tsx`（:240-289）のマーカー生成 useMemo を
 * 純関数へ移植し、頭文字グリフ・presence専用スタッフ(zoneId="")の除外・
 * 移動指示のゴースト線描画を追加した。決定的計算のみ（LLMは関与しない）。
 */

// ── ポストコード ──────────────────────────────────────────────────

/**
 * ポスト照合は完全一致のみ。
 *
 * 旧実装は `startsWith` で判定しており「A-1」が「A-10」にも誤マッチしていた
 * （2桁目の連番が生まれた瞬間に事故る）。空文字は「未配置」であってポストではないため、
 * 双方が空文字でも false（`staffPostCode === ""` の時点で弾く。`postCode` 側の中身は
 * 見るまでもなく不一致）。
 */
export function isAssignedTo(staffPostCode: string, postCode: string): boolean {
  if (staffPostCode === "") return false;
  return staffPostCode === postCode;
}

/**
 * ポストコードの表示ラベル。
 * - 空文字 → 「未配置」
 * - 末尾が「→」（移動中を表す旧コードへの付与。staff-console.tsx の「着きました」応答参照）
 *   → 「元コードから移動中」
 * - それ以外 → そのまま
 */
export function postCodeLabel(code: string): string {
  if (code === "") return "未配置";
  if (code.endsWith("→")) return `${code.slice(0, -1)}から移動中`;
  return code;
}

// ── メンバーバッジ ────────────────────────────────────────────────

export type MemberStatus = "unregistered" | "waiting" | "onpost" | "moving" | "away";

export type MemberBadge = { status: MemberStatus; stale: boolean; unanswered: boolean };

/**
 * 名簿1行分のバッジ。status は優先順に判定する:
 *   1. staff が無い → unregistered（名簿未登録。事前配置の指示だけ飛んでいることがある）
 *   2. postCode==="" && state==="away" → waiting（プレゼンス登録のみ・現場入り前）
 *   3. state==="onpost" → onpost
 *   4. state==="moving" → moving
 *   5. それ以外（postCode有り && state==="away" 等） → away
 *
 * stale: staff が存在し、かつ最終更新から15分超（adjust-console.tsx の stale() と同閾値・同境界＝ `>`）。
 * unanswered: 直近の有効指示が status==="sent" のまま10分超応答なし。
 *   staff の有無に関わらず判定する（unregistered でも効く＝事前配置の未応答検出のため）。
 */
export function memberBadge(
  staff: Staff | undefined,
  latestDispatch: Dispatch | undefined,
  now: number
): MemberBadge {
  let status: MemberStatus;
  if (!staff) {
    status = "unregistered";
  } else if (staff.postCode === "" && staff.state === "away") {
    status = "waiting";
  } else if (staff.state === "onpost") {
    status = "onpost";
  } else if (staff.state === "moving") {
    status = "moving";
  } else {
    status = "away";
  }

  const stale = staff !== undefined && now - staff.updatedAt > 15 * 60_000;
  const unanswered =
    latestDispatch !== undefined &&
    latestDispatch.status === "sent" &&
    now - latestDispatch.createdAt > 10 * 60_000;

  return { status, stale, unanswered };
}

/** その名前の最新の有効指示（createdAt降順の先頭）。cancelled は除外する。無ければ undefined */
export function latestDispatchFor(name: string, dispatches: Dispatch[]): Dispatch | undefined {
  const active = dispatches.filter((d) => d.staffName === name && d.status !== "cancelled");
  if (active.length === 0) return undefined;
  return active.reduce((latest, d) => (d.createdAt > latest.createdAt ? d : latest));
}

// ── マップ描画 ────────────────────────────────────────────────────

/**
 * `zoneId` はドラッグ&ドロップの当たり判定用（2026-08-13 追加）。
 * 会場図ではスタッフの丸はゾーンの `<g>` の**兄弟**として描かれるため、丸の上で指を離すと
 * `closest("[data-zone-id]")` が親を辿っても何も見つからない（＝空席の丸を狙って落とすという
 * 一番自然な操作がデッドスポットになる）。丸自身にゾーンを持たせて解消する。
 */
export type BoardMark = { at: Point; role: PostRole; label: string; glyph: string; zoneId: string };

export type GhostMark = { from: Point | null; to: Point; glyph: string; kind: "sent" | "moving" };

export type BoardModel = {
  /** 実在スタッフ→薄丸空席の順 */
  marks: BoardMark[];
  /** marks と同indexで、実在スタッフ or null(空席) */
  entryStaff: (Staff | null)[];
  /** 空席marksのindex集合 */
  dimmedIdx: Set<number>;
  /** ゾーン別の入場スタッフ数（zoneId="" は除外） */
  zoneBadges: Record<string, number>;
  /** アクティブ指示の可視化 */
  ghosts: GhostMark[];
};

/** 空席ポストのグリフ（役割の頭文字。staffing.ts の ROLE_LABEL とは別に配置ボード表示専用で持つ） */
const ROLE_GLYPH: Record<PostRole, string> = {
  water: "水",
  guide: "誘",
  aid: "救",
  reception: "受",
};

/**
 * adjust-console.tsx:240-289 の移植＋拡張。
 *
 * - presence登録のみ（zoneId===""）のスタッフは (0,0) に描かず、marks にも zoneBadges にも出さない
 * - 実在スタッフの glyph は名前の頭文字（名簿は頭文字ユニーク前提）
 * - 空席ポストの glyph は役割グリフ（ROLE_GLYPH）
 * - ghosts は status が "sent"|"moving" の指示ごとに1本。to は対象ゾーンの centroid、
 *   from はその staffName の現在マーカー座標（見つからなければ null）、
 *   glyph は staffName の頭文字。toZoneId が実在しないゾーンはスキップする
 */
export function buildBoardMarks(staffList: Staff[], posts: Post[], dispatches: Dispatch[]): BoardModel {
  const marks: BoardMark[] = [];
  const entryStaff: (Staff | null)[] = [];
  const dimmedIdx = new Set<number>();
  const zoneBadges: Record<string, number> = {};

  const byZone = new Map<string, Staff[]>();
  for (const s of staffList) {
    if (!s.zoneId) continue;
    const arr = byZone.get(s.zoneId) ?? [];
    arr.push(s);
    byZone.set(s.zoneId, arr);
    zoneBadges[s.zoneId] = (zoneBadges[s.zoneId] ?? 0) + 1;
  }

  byZone.forEach((list, zoneId) => {
    const basePost = posts.find((p) => p.zoneId === zoneId);
    const zone = zoneById(zoneId);
    const base = basePost?.at ?? (zone ? centroid(zone.shape) : { x: 0, y: 0 });
    list.forEach((s, i) => {
      marks.push({
        // 40px間隔（2026-08-14、staffing.ts の put()/putReceptionRow() と同じ拡張。
        // 人員配置エディタの駒 r=16 化に合わせて34px→40pxへ。同一ゾーン内の隙間を確保する）
        at: { x: base.x + (i - (list.length - 1) / 2) * 40, y: base.y },
        role: s.role,
        label: s.postCode,
        glyph: s.name.charAt(0),
        zoneId,
      });
      entryStaff.push(s);
    });
  });

  const postsByZone = new Map<string, Post[]>();
  for (const p of posts) {
    const arr = postsByZone.get(p.zoneId) ?? [];
    arr.push(p);
    postsByZone.set(p.zoneId, arr);
  }
  postsByZone.forEach((zonePosts, zoneId) => {
    const occupied = byZone.get(zoneId)?.length ?? 0;
    for (const p of zonePosts.slice(occupied)) {
      dimmedIdx.add(marks.length);
      marks.push({ at: p.at, role: p.role, label: p.code, glyph: ROLE_GLYPH[p.role], zoneId });
      entryStaff.push(null);
    }
  });

  const ghosts: GhostMark[] = [];
  for (const d of dispatches) {
    if (d.status !== "sent" && d.status !== "moving") continue;
    const zone = zoneById(d.toZoneId);
    if (!zone) continue;
    const to = centroid(zone.shape);
    const fromIdx = entryStaff.findIndex((s) => s?.name === d.staffName);
    const from = fromIdx >= 0 ? marks[fromIdx].at : null;
    ghosts.push({ from, to, glyph: d.staffName.charAt(0), kind: d.status });
  }

  return { marks, entryStaff, dimmedIdx, zoneBadges, ghosts };
}
