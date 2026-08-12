/**
 * 当日のタイムテーブル（デモデータ）。
 *
 * 2026-08-13 新設。従来のモデルは「何時にどのステージへ人が集まる予定か」を
 * 一切知らなかった（在場率カーブは会場全体の1本だけ）。実際の混雑は
 * 演目に駆動される: 人気アクト中はステージが膨らみ、幕間に物販・トイレ・
 * フードが跳ね、大トリ終了で退場が始まる。
 *
 * ⚠ これは**架空イベントのデモデータ**（実測に見せかけない）。
 * 実運用ではイベンターの進行表がこの型で入る。T0（事前・計画時に確定する情報）に属する。
 */

export type TimetableItem = {
  /** ステージのゾーンID（main = メインステージ / sub = サブステージ） */
  stage: "main" | "sub";
  act: string;
  /** 開始・終了（時。0.5=30分） */
  from: number;
  to: number;
  /**
   * 集客力 0-1。そのステージの定員に対してどれだけ埋めるか。
   * ヘッドライナー=1.0、オープニング=0.4程度
   */
  draw: number;
};

/** みなと臨海公園 特設会場・真夏の音楽フェス（架空）の進行 */
export const TIMETABLE: TimetableItem[] = [
  { stage: "main", act: "オープニングアクト", from: 11.5, to: 12.5, draw: 0.4 },
  { stage: "sub", act: "ルーキーステージ", from: 12, to: 13, draw: 0.5 },
  { stage: "main", act: "昼の部（中堅バンド）", from: 13, to: 14.5, draw: 0.7 },
  { stage: "sub", act: "アコースティック", from: 14, to: 15, draw: 0.6 },
  { stage: "main", act: "ゲストアクト", from: 15, to: 16.5, draw: 0.9 },
  { stage: "sub", act: "DJステージ", from: 16, to: 18, draw: 0.7 },
  { stage: "main", act: "夕方の部", from: 17, to: 18.5, draw: 0.8 },
  { stage: "main", act: "ヘッドライナー", from: 19, to: 20.5, draw: 1.0 },
];

/** その時刻に演目中のアイテム（いなければnull）。t は小数可（14.5=14:30） */
export function actAt(stage: "main" | "sub", t: number): TimetableItem | null {
  return TIMETABLE.find((x) => x.stage === stage && x.from <= t && t < x.to) ?? null;
}

/**
 * その時刻が「幕間」か（メインステージに演目がなく、直前直後に演目がある時間帯）。
 * 幕間は物販・トイレ・フードが跳ねる時間。
 */
export function isIntermission(t: number): boolean {
  if (actAt("main", t)) return false;
  const before = TIMETABLE.some((x) => x.stage === "main" && x.to <= t && t - x.to < 1.5);
  const after = TIMETABLE.some((x) => x.stage === "main" && x.from > t && x.from - t < 1.5);
  return before && after;
}

/** AI指示書に渡す文脈（「次のヘッドライナーで何時に膨らむか」を書かせる材料） */
export function timetableContext(hour: number): {
  nowMain: string | null;
  nowSub: string | null;
  next: { act: string; stage: string; from: number; draw: number } | null;
} {
  const nowMain = actAt("main", hour);
  const nowSub = actAt("sub", hour);
  const next =
    TIMETABLE.filter((x) => x.from > hour).sort((a, b) => a.from - b.from)[0] ?? null;
  return {
    nowMain: nowMain?.act ?? null,
    nowSub: nowSub?.act ?? null,
    next: next
      ? {
          act: next.act,
          stage: next.stage === "main" ? "メインステージ" : "サブステージ",
          from: next.from,
          draw: next.draw,
        }
      : null,
  };
}
