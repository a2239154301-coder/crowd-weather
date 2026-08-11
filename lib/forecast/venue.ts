import type { Building, Point, Scenario, Venue, Zone } from "./types";

/**
 * デモ用の架空会場「みなと臨海公園 特設会場」。
 *
 * 実在会場の警備配置をそのまま公開しないため、すべて架空。
 * 優先01（会場図面・過去計画書の読解）が最終的に生成するのは、このファイルと同じ形の
 * Venue オブジェクト。つまりこれは「AIが吐く出力の手書き版」であり、
 * 出力先のUIを先に作っておくことで、読解機能の受け皿が確定する。
 *
 * 座標系は 1000 x 700。北が上（y-）、東が右（x+）。
 */

const rect = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/**
 * 建物。日陰予報の入力になる。height（m）が影の長さを決める。
 *
 * 開場は11:00。その時点で太陽はすでに南南東にあるため、影は北→北東→東へ回る。
 * つまり **日中は日陰がほとんどなく、夕方に一気に伸びる**。
 * これは演出ではなく計算結果で、「昼が最も危険」という本プロダクトの主張そのもの。
 */
const buildings: Building[] = [
  // 北：駅ビル。夕方、東へ長い影を落とす
  { id: "b-station", name: "臨海公園駅", shape: rect(300, 8, 400, 66), height: 46 },
  // 西：多目的ホール。15時以降、東隣のフードコートに影を伸ばす
  { id: "b-sub", name: "多目的ホール", shape: rect(70, 330, 190, 150), height: 38 },
  // 東：物販棟
  { id: "b-shop", name: "物販棟", shape: rect(720, 330, 130, 120), height: 28 },
  // 東端：立体駐車場
  { id: "b-park", name: "立体駐車場", shape: rect(880, 250, 100, 210), height: 44 },
  // 南西：運営本部
  { id: "b-ops", name: "運営本部", shape: rect(120, 560, 110, 80), height: 12 },
  // 客席内のディレイタワー。footprint は小さいが高く、細い影が客席を横切る
  { id: "b-twr-w", name: "ディレイタワー西", shape: rect(372, 296, 22, 22), height: 20 },
  { id: "b-twr-e", name: "ディレイタワー東", shape: rect(626, 296, 22, 22), height: 20 },
];

/** 地面の下地。会場図として読めるようにするための塗り分け */
const ground: Venue["ground"] = [
  { id: "g-water", kind: "water", shape: [
    { x: 0, y: 640 }, { x: 1000, y: 600 }, { x: 1000, y: 700 }, { x: 0, y: 700 },
  ] },
  { id: "g-lawn", kind: "grass", shape: [
    { x: 250, y: 150 }, { x: 790, y: 150 }, { x: 830, y: 560 }, { x: 210, y: 570 },
  ] },
  { id: "g-plaza", kind: "paved", shape: rect(0, 74, 1000, 76) },
  { id: "g-deck", kind: "deck", shape: [
    { x: 210, y: 570 }, { x: 830, y: 560 }, { x: 850, y: 620 }, { x: 190, y: 630 },
  ] },
];

/**
 * 会場内ゾーン。旧モックの IN_ZONES と同じ意味を、実際の形で持たせたもの。
 * base = そのゾーン固有の混みやすさ係数（旧モックの値を踏襲）。
 */
const inZones: Zone[] = [
  // queueArea = 実際に人が待つ帯の面積(m²)。テント必要数の分母（値は馬場v4のSZONESを踏襲）
  {
    id: "corr", name: "駅連絡通路", kind: "corridor", base: 0.9, roofed: true, queueArea: 220,
    shape: [{ x: 430, y: 74 }, { x: 570, y: 74 }, { x: 560, y: 165 }, { x: 440, y: 165 }],
  },
  {
    id: "wg", name: "西ゲート", kind: "gate", base: 0.85, queueArea: 180,
    shape: [{ x: 215, y: 168 }, { x: 340, y: 158 }, { x: 345, y: 222 }, { x: 220, y: 232 }],
  },
  {
    id: "eg", name: "東ゲート", kind: "gate", base: 0.85, queueArea: 180,
    shape: [{ x: 680, y: 158 }, { x: 800, y: 168 }, { x: 800, y: 232 }, { x: 678, y: 222 }],
  },
  {
    id: "main", name: "メインステージ", kind: "stage", base: 1.0,
    shape: [{ x: 360, y: 250 }, { x: 660, y: 250 }, { x: 700, y: 500 }, { x: 330, y: 505 }],
    label: { x: 512, y: 300 },
  },
  {
    id: "sub", name: "サブステージ（屋内）", kind: "indoor", base: 0.6, roofed: true,
    shape: rect(78, 338, 174, 134),
  },
  {
    id: "shop", name: "物販の列", kind: "queue", base: 0.75, queueArea: 240,
    shape: [{ x: 620, y: 345 }, { x: 712, y: 340 }, { x: 716, y: 452 }, { x: 624, y: 456 }],
  },
  {
    id: "food", name: "フードコート", kind: "queue", base: 0.7, queueArea: 200,
    shape: [{ x: 268, y: 342 }, { x: 344, y: 340 }, { x: 348, y: 470 }, { x: 272, y: 472 }],
  },
  {
    id: "wc", name: "トイレの列", kind: "queue", base: 0.55, queueArea: 120,
    shape: rect(268, 492, 96, 62),
  },
  {
    id: "aid", name: "救護・給水", kind: "aid", base: 0.35, roofed: true, queueArea: 100,
    shape: rect(600, 492, 116, 62),
  },
  {
    id: "exit", name: "退場動線", kind: "corridor", base: 0.9,
    shape: [{ x: 214, y: 575 }, { x: 826, y: 565 }, { x: 844, y: 616 }, { x: 196, y: 626 }],
  },
];

/** 会場外ゾーン。事故の多くは会場の外で起きる、というのが本プロダクトの主張 */
const outZones: Zone[] = [
  { id: "plat", name: "駅ホーム", kind: "station", base: 0.8, roofed: true, shape: rect(310, 16, 380, 24) },
  { id: "conc", name: "改札コンコース", kind: "station", base: 0.9, roofed: true, shape: rect(330, 44, 340, 26) },
  { id: "plaza", name: "駅前広場", kind: "corridor", base: 0.7, shape: rect(300, 82, 400, 62) },
  {
    id: "alley", name: "商店街の路地", kind: "alley", base: 1.0,
    shape: [{ x: 96, y: 84, }, { x: 250, y: 84 }, { x: 250, y: 128 }, { x: 96, y: 128 }],
  },
  { id: "blvd", name: "大通り歩道", kind: "corridor", base: 0.75, shape: rect(750, 84, 236, 44) },
  { id: "bus", name: "シャトルバス待機列", kind: "queue", base: 0.8, shape: rect(760, 470, 210, 70) },
  {
    id: "wgf", name: "西ゲート前", kind: "gate", base: 0.85,
    shape: [{ x: 120, y: 190 }, { x: 210, y: 178 }, { x: 214, y: 246 }, { x: 124, y: 258 }],
  },
  {
    id: "egf", name: "東ゲート前", kind: "gate", base: 0.85,
    shape: [{ x: 806, y: 178 }, { x: 894, y: 190 }, { x: 890, y: 258 }, { x: 802, y: 246 }],
  },
];

export const VENUE: Venue = {
  id: "minato-rinkai",
  name: "みなと臨海公園 特設会場",
  width: 1000,
  height: 700,
  open: 11,
  close: 21,
  zones: [...inZones, ...outZones],
  buildings,
  ground,
};

export const IN_ZONE_IDS = new Set(inZones.map((z) => z.id));

export function zonesFor(scope: "in" | "out"): Zone[] {
  return VENUE.zones.filter((z) => (scope === "in" ? IN_ZONE_IDS.has(z.id) : !IN_ZONE_IDS.has(z.id)));
}

export const HOURS: number[] = Array.from(
  { length: VENUE.close - VENUE.open + 1 },
  (_, i) => VENUE.open + i
);

/**
 * 予報条件の初期値。真夏の屋外フェス想定（馬場v4の既定と同じ）。
 * Scenario にフィールドを足したら、ここを直せば全画面に行き渡る。
 */
export const DEFAULT_SCENARIO: Scenario = {
  weather: "sunny",
  temp: 34,
  tickets: 24000,
  rhPct: 60,
  windMs: 1.5,
  date: { y: 2026, mo: 8, d: 8, label: "8/8 真夏" },
  geo: { name: "東京", lat: 35.6895, lon: 139.6917 },
};
