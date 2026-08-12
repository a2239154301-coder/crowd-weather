import type { DayPlan, Point, Zone } from "@/lib/forecast/types";
import { VENUE, zonesFor } from "@/lib/forecast/venue";
import { centroid } from "@/lib/forecast/model";

/**
 * 配置ポスト — 計画（推奨オペレーション）と当日運用（スタッフ・指示）をつなぐ背骨。
 *
 * 2026-08-13 新設。従来 `marksFor()`（ops-console ローカル）は地図に丸を描くだけの
 * 表示用データだった。当日モードでスタッフに「どこへ行って何をするか」を指示するには、
 * 配置が**名前を持った実体**である必要がある:
 *
 *   - ポストコード `A-1` `A-2` … 現場の無線・掲示と同じ語彙。
 *     「A-2へ行って給水誘導」という指示がそのまま成立する
 *   - 計画書の配置図・調整コンソールの配置ボード・スタッフの受信箱が
 *     全部同じコードを使う（計画と実際のAdjustmentが同じ語彙で繋がる）
 *
 * `dayPlan()` の推奨人数から**決定的に**生成する。計画の条件を変えると
 * 推奨人数が変わり、ポストの数も変わる（計画がそのまま名簿になる）。
 */

export type PostRole = "water" | "guide" | "aid";

export type Post = {
  /** ポストコード。エリア記号-連番（例 A-1） */
  code: string;
  zoneId: string;
  zoneName: string;
  /** 会場図上の位置（viewBox座標） */
  at: Point;
  role: PostRole;
};

export const ROLE_LABEL: Record<PostRole, string> = {
  water: "給水",
  guide: "誘導",
  aid: "救護",
};

/**
 * ゾーン → エリア記号。現場で口頭・無線で使う1文字。
 * 会場内の主要ゾーンに固定で振る（並び順ではなく地理で覚えられるよう固定割当）。
 */
export const AREA_CODE: Record<string, string> = {
  wg: "A", // 西ゲート
  eg: "B", // 東ゲート
  main: "C", // メインステージ
  shop: "D", // 物販の列
  exit: "E", // 退場動線
  food: "F", // フードコート
  wc: "G", // トイレの列
  aid: "H", // 救護・給水
  sub: "I", // サブステージ
  corr: "J", // 駅連絡通路
};

/**
 * 計画から配置ポストを生成する。
 *
 * 配分ロジックは旧 `marksFor()`（ops-console.tsx にあった表示用関数）を踏襲し、
 * 人数の根拠は `dayPlan()` の water/guide/aid。同じ入力なら必ず同じポスト列になる
 * （コードの安定性が大事: 指示は「A-2へ」の形で飛ぶので、再計算でコードがズレると事故）。
 */
export function postsFor(plan: DayPlan): Post[] {
  const inside = zonesFor("in");
  const posts: Post[] = [];
  const counters: Record<string, number> = {};

  const put = (zoneId: string, role: PostRole, n: number) => {
    const z = inside.find((v) => v.id === zoneId);
    if (!z || n <= 0) return;
    const area = AREA_CODE[zoneId] ?? "Z";
    const c = z.label ?? centroid(z.shape);
    for (let i = 0; i < n; i++) {
      counters[area] = (counters[area] ?? 0) + 1;
      posts.push({
        code: `${area}-${counters[area]}`,
        zoneId,
        zoneName: z.name,
        // 同一ゾーン内は横に34pxずつ並べる（旧marksForの配置と同じ）
        at: { x: c.x + (i - (n - 1) / 2) * 34, y: c.y + 26 },
        role,
      });
    }
  };

  // 旧 marksFor と同じ配分（給水→物販・トイレ / 誘導→ステージ・退場 / 救護→救護所）
  put("shop", "water", Math.min(2, plan.water));
  if (plan.water > 2) put("wc", "water", 1);
  put("main", "guide", Math.min(3, plan.guide));
  if (plan.guide > 3) put("exit", "guide", Math.min(2, plan.guide - 3));
  // 誘導が5名を超える分はゲートへ（開場・終演の詰まり対応。ポスト名簿化で追加）
  if (plan.guide > 5) {
    const rest = plan.guide - 5;
    put("wg", "guide", Math.ceil(rest / 2));
    put("eg", "guide", Math.floor(rest / 2));
  }
  put("aid", "aid", Math.min(2, plan.aid));
  if (plan.aid > 2) put("aid", "aid", plan.aid - 2);

  return posts;
}

/** 地図表示用の互換変換（VenueMap の StaffMark と同じ形）。ラベルにポストコードを載せる */
export function postsToMarks(posts: Post[]): { at: Point; role: PostRole; label: string }[] {
  return posts.map((p) => ({ at: p.at, role: p.role, label: p.code }));
}

/** ゾーンIDの実在チェック（AI提案の検証・APIの入力検証で使う） */
export function isValidZoneId(zoneId: string): boolean {
  return VENUE.zones.some((z) => z.id === zoneId);
}

export function zoneById(zoneId: string): Zone | undefined {
  return VENUE.zones.find((z) => z.id === zoneId);
}
