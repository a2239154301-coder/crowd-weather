import type { PostRole } from "@/lib/ops/staffing";

/**
 * 仮メンバー名簿（デモ用）。
 *
 * 2026-08-13 新設。配置ボード（当日運用）で「どのポストに誰が入っているか」を
 * 名前で示す実践運用デモのための仮名簿。`postsFor()` が生成するポスト（A-1・R-3等）に
 * スタッフを割り当てる操作を、実在の氏名を使わずにデモできるようにする。
 *
 * ⚠ 架空の名簿。実在の人物とは無関係（実測・実在に見せかけない）。
 *
 * ## 設計判断（姓の頭文字ユニーク）
 *
 * 姓は全員「頭文字（先頭の漢字）がユニーク」になるよう選定した。地図上のマーカーに
 * フルネームを載せると地図が読めなくなるため、頭文字1文字だけをマーカーの識別子として
 * 使う運用を想定している（頭文字が重複すると、どの丸がどのスタッフか地図上で区別できない）。
 * 「鈴木」は候補から意図的に除外した（入場フォームのplaceholderとして既に使われており、
 * 名簿に入れると紛らわしいため）。ディレクターは名簿外（配置ポストに立つスタッフではなく、
 * 調整コンソールを操作する側の人間のため）。
 */

export type RosterGroup = "メイン" | "フード" | "サブ" | "給水" | "救護" | "受付" | "遊軍";

export type RosterMember = {
  id: string;
  name: string;
  role: PostRole;
  group: RosterGroup;
};

export const ROSTER: RosterMember[] = [
  // メイン（誘導）
  { id: "s01", name: "佐藤", role: "guide", group: "メイン" },
  { id: "s02", name: "高橋", role: "guide", group: "メイン" },
  { id: "s03", name: "田中", role: "guide", group: "メイン" },
  { id: "s04", name: "伊藤", role: "guide", group: "メイン" },
  { id: "s05", name: "渡辺", role: "guide", group: "メイン" },
  // フード（誘導）
  { id: "s06", name: "山本", role: "guide", group: "フード" },
  { id: "s07", name: "中村", role: "guide", group: "フード" },
  { id: "s08", name: "小林", role: "guide", group: "フード" },
  // サブ（誘導）
  { id: "s09", name: "加藤", role: "guide", group: "サブ" },
  { id: "s10", name: "吉田", role: "guide", group: "サブ" },
  { id: "s11", name: "池田", role: "guide", group: "サブ" },
  // 給水
  { id: "s12", name: "松本", role: "water", group: "給水" },
  { id: "s13", name: "森田", role: "water", group: "給水" },
  // 救護
  { id: "s14", name: "井上", role: "aid", group: "救護" },
  { id: "s15", name: "木村", role: "aid", group: "救護" },
  // 受付
  { id: "s16", name: "林", role: "reception", group: "受付" },
  { id: "s17", name: "斎藤", role: "reception", group: "受付" },
  { id: "s18", name: "清水", role: "reception", group: "受付" },
  { id: "s19", name: "石川", role: "reception", group: "受付" },
  { id: "s20", name: "前田", role: "reception", group: "受付" },
  { id: "s21", name: "藤井", role: "reception", group: "受付" },
  { id: "s22", name: "岡田", role: "reception", group: "受付" },
  { id: "s23", name: "長谷川", role: "reception", group: "受付" },
  // 遊軍: 手動追加用に予約
];

export function rosterById(id: string): RosterMember | undefined {
  return ROSTER.find((m) => m.id === id);
}

export function rosterByName(name: string): RosterMember | undefined {
  return ROSTER.find((m) => m.name === name);
}
