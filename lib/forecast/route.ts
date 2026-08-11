import type { Point, Scenario, Zone } from "./types";
import { VENUE } from "./venue";
import { centroid, forecastZones, pointInPolygon, UNITS_PER_METER } from "./model";

/**
 * 来場者向けの経路探索（馬場氏の要望「救護・給水までのルートをAIで算出」への実装）。
 *
 * **経路探索にLLMは使わない。** ダイクストラ法の決定的な計算で出す。
 * LLMは出てきた経路を一言で説明する用途にだけ使う（`/api/advice` mode=route）。
 * 理由は3つ:
 *   1. 安全に関わる案内で、毎回違う答えが返るのは受け入れられない
 *   2. 経路は数msで出せる。LLMに投げると数秒かかり、来場者アプリの体験として遅い
 *   3. 「混雑・暑熱の計算にLLMを使わない」という本製品の設計方針と同じ（審査項目⑥）
 *
 * グラフの作り方:
 *   ノード = ゾーンの代表点。エッジ = 一定距離内にあり、**建物を貫通しない**ゾーン対。
 *   建物越えを弾くので、経路は自然に建物を迂回する。
 */

/** これ以上離れたゾーン同士は直接つながない（viewBox単位。約152m） */
const MAX_EDGE_UNITS = 380;

/** 混雑指数がこれ以上のゾーンは「危険」帯（lib/forecast/scales.ts の densityBand と同じ閾値） */
const DANGER_DENSITY = 75;

/** 徒歩速度。混雑時は歩けないので所要時間の目安に使う（m/分） */
const WALK_SPEED_M_PER_MIN = 70;

export type RoutePreference =
  /** とにかく近い道 */
  | "short"
  /** 混雑を避ける（はぐれ・将棋倒しを避けたい） */
  | "safe"
  /** 日陰を通る（暑さを避けたい） */
  | "cool";

export type RouteStep = {
  zone: Zone;
  density: number;
  wbgt: number;
  shadeFraction: number;
};

export type RouteResult = {
  steps: RouteStep[];
  /** 総距離（m） */
  meters: number;
  /** 徒歩の目安（分） */
  minutes: number;
  /** 経路上の最大混雑指数 */
  maxDensity: number;
  /** 経路上の最大WBGT */
  maxWbgt: number;
  /** 経路の平均日陰率 0-1 */
  shadeRatio: number;
  /**
   * 来場者にそのまま伝えるべき注意。
   * 「迂回しても危険帯を避けられなかった」＝会場が飽和しているという事実は
   * 黙って最良の経路だけ返すより、伝えたほうが安全側に働く。
   */
  warnings: string[];
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** ゾーンの代表点。label が指定されていればそれ（地図上のラベル位置と一致させる） */
export const anchorOf = (z: Zone): Point => z.label ?? centroid(z.shape);

/** 線分の交差判定（端点の接触も交差とみなす簡易版） */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * 2点を結ぶ線分が建物の footprint を貫通するか。
 *
 * ⚠ 端点がその建物の中にある場合は「貫通」と数えない。
 * 屋内ゾーン（サブステージ等）は建物の中にあるのが正しく、
 * ここで弾くと屋内ゾーンから一歩も出られなくなる
 * （2026-08-11実測: サブステージ→救護が到達不可になっていた）。
 * 出入口の位置まではモデル化しないので、自分がいる建物は素通りできる扱いにする。
 */
function crossesBuilding(a: Point, b: Point): boolean {
  for (const bld of VENUE.buildings) {
    const poly = bld.shape;
    // どちらかの端点がこの建物の中 = その建物の中／出入りの移動。貫通とはみなさない
    if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) continue;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segmentsCross(a, b, poly[j], poly[i])) return true;
    }
  }
  return false;
}

/**
 * 移動コスト。距離（m）に「通りたくなさ」を掛ける。
 *
 * ⚠ **混雑のペナルティは距離に対して非線形（3乗）にしている。**
 * 群集事故のリスクは密度に比例して増えるのではなく、ある密度を超えたところから
 * 急激に立ち上がる（`docs/DATA-SOURCES.ja.md` の群集密度research参照。
 * 明石歩道橋事故の実測は13〜15人/m²）。線形ペナルティだと
 * 「混雑93のゾーン」と「混雑100のゾーン」がほぼ同じ扱いになり、
 * 実際に混雑100の観客エリアを突っ切る経路が選ばれてしまった（2026-08-11実測）。
 * 3乗＋危険帯の割増にすると、迂回できる場合は確実に迂回するようになる。
 *
 * 重みは preference で変える:
 *   short … ほぼ距離だけ
 *   safe  … 混雑を強く嫌う
 *   cool  … 日向・高WBGTを強く嫌う
 */
function edgeCost(
  meters: number,
  from: RouteStep,
  to: RouteStep,
  preference: RoutePreference
): number {
  const dAvg = (from.density + to.density) / 2 / 100; // 0-1
  const crowd = dAvg ** 3; // 非線形。0.93³=0.80 に対し 1.0³=1.00
  const heat = Math.max(0, (from.wbgt + to.wbgt) / 2 - 25) / 10; // WBGT25超過分
  const sun = 1 - (from.shadeFraction + to.shadeFraction) / 2; // 日向率 0-1
  // 危険帯を通ること自体への割増（どちらかの端点が危険なら課す）
  const danger = Math.max(from.density, to.density) >= DANGER_DENSITY ? 1 : 0;

  const w =
    preference === "short"
      ? { crowd: 0.5, heat: 0.2, sun: 0.1, danger: 0.15 }
      : preference === "safe"
        ? { crowd: 6.0, heat: 0.4, sun: 0.2, danger: 1.2 }
        : { crowd: 1.2, heat: 1.8, sun: 1.6, danger: 0.3 };

  return meters * (1 + w.crowd * crowd + w.heat * heat + w.sun * sun + w.danger * danger);
}

/**
 * 目的地の候補。「救護・給水」「涼しい休憩場所」など、
 * 来場者が実際に探すものをゾーンの kind から拾う。
 */
export function destinationsFor(zones: Zone[]): { id: string; label: string; zone: Zone }[] {
  const out: { id: string; label: string; zone: Zone }[] = [];
  for (const z of zones) {
    if (z.kind === "aid") out.push({ id: z.id, label: `救護・給水（${z.name}）`, zone: z });
  }
  for (const z of zones) {
    if (z.kind === "queue" && z.name.includes("トイレ")) {
      out.push({ id: z.id, label: `トイレ（${z.name}）`, zone: z });
    }
  }
  return out;
}

/**
 * from から to への経路をダイクストラ法で求める。
 * 到達できない場合は null（グラフが分断されているとき）。
 */
export function findRoute(
  zones: Zone[],
  fromId: string,
  toId: string,
  hour: number,
  scenario: Scenario,
  preference: RoutePreference = "safe"
): RouteResult | null {
  // その時刻の予報を1回だけ計算し、ノードの属性にする
  const forecast = forecastZones(zones, hour, scenario);
  const nodes = new Map<string, RouteStep>();
  for (const f of forecast) {
    nodes.set(f.zone.id, {
      zone: f.zone,
      density: f.density,
      wbgt: f.wbgt,
      shadeFraction: f.shadeFraction,
    });
  }
  if (!nodes.has(fromId) || !nodes.has(toId)) return null;

  // 隣接リスト（建物を貫通しない・一定距離内のゾーン対）
  const ids = [...nodes.keys()];
  const adj = new Map<string, { to: string; meters: number }[]>();
  for (const id of ids) adj.set(id, []);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = nodes.get(ids[i])!;
      const b = nodes.get(ids[j])!;
      const pa = anchorOf(a.zone);
      const pb = anchorOf(b.zone);
      const d = dist(pa, pb);
      if (d > MAX_EDGE_UNITS) continue;
      if (crossesBuilding(pa, pb)) continue;
      const meters = d / UNITS_PER_METER;
      adj.get(ids[i])!.push({ to: ids[j], meters });
      adj.get(ids[j])!.push({ to: ids[i], meters });
    }
  }

  // ダイクストラ（ノード数が数十なので単純な線形探索で十分）
  const best = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  for (const id of ids) best.set(id, Number.POSITIVE_INFINITY);
  best.set(fromId, 0);

  while (visited.size < ids.length) {
    let cur: string | null = null;
    let curCost = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      if (visited.has(id)) continue;
      const c = best.get(id)!;
      if (c < curCost) {
        cur = id;
        curCost = c;
      }
    }
    if (cur === null || curCost === Number.POSITIVE_INFINITY) break;
    if (cur === toId) break;
    visited.add(cur);

    for (const e of adj.get(cur)!) {
      if (visited.has(e.to)) continue;
      const cost = curCost + edgeCost(e.meters, nodes.get(cur)!, nodes.get(e.to)!, preference);
      if (cost < best.get(e.to)!) {
        best.set(e.to, cost);
        prev.set(e.to, cur);
      }
    }
  }

  if (best.get(toId) === Number.POSITIVE_INFINITY) return null;

  // 経路の復元
  const path: string[] = [toId];
  let cursor = toId;
  while (cursor !== fromId) {
    const p = prev.get(cursor);
    if (!p) return null;
    path.unshift(p);
    cursor = p;
  }

  const steps = path.map((id) => nodes.get(id)!);
  let meters = 0;
  for (let i = 1; i < steps.length; i++) {
    meters += dist(anchorOf(steps[i - 1].zone), anchorOf(steps[i].zone)) / UNITS_PER_METER;
  }

  const maxDensity = Math.max(...steps.map((s) => s.density));
  const maxWbgt = Math.max(...steps.map((s) => s.wbgt));
  const shadeRatio = steps.reduce((a, s) => a + s.shadeFraction, 0) / steps.length;

  const warnings: string[] = [];
  const crowded = steps.filter((s) => s.density >= DANGER_DENSITY);
  if (crowded.length > 0) {
    warnings.push(
      `この時間はどの道を選んでも混雑します（${crowded.map((s) => s.zone.name).join("・")}）。` +
        `急がず、立ち止まらずに進んでください。`
    );
  }
  if (maxWbgt >= 31) {
    warnings.push("経路上に暑さ危険の場所があります。水を持って移動してください。");
  }

  return {
    steps,
    meters: Math.round(meters),
    minutes: Math.max(1, Math.round(meters / WALK_SPEED_M_PER_MIN)),
    maxDensity,
    maxWbgt,
    shadeRatio,
    warnings,
  };
}
