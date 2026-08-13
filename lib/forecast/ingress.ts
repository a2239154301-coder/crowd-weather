/**
 * 入場ピークモデル（到着カーブ×ゲート容量の待ち行列・1時間刻み・決定的）。
 *
 * 「開場直後にどのゲートで何分待たされるか」を数字で示すのがこのモジュールの
 * 存在理由。退場側（egress.ts）が終演後の系外流出を扱うのに対し、こちらは
 * 開場〜終演にかけての系内への流入（＝手荷物検査を含むゲート通過）を扱う。
 *
 * 設計方針:
 * - LLM不使用・完全決定的。同じ入力は常に同じ出力（egress.ts と同じくこの
 *   リポジトリの文化。雑踏の安全に関わる数字が実行のたびに変わってはならない）
 * - 他モジュールをimportしない自己完結。**lib/forecast/model.ts は凍結のため
 *   import禁止**。model.ts の OCCUPANCY と同値の自前コピーを下に持つ
 *   （egress.ts の CLOSING_OCCUPANCY と同じ方針。値がずれたら両方直すこと）
 * - 「純増近似」の限界: 在場率カーブの時間差分をそのまま到着人数として使う。
 *   在場率が減る時間帯（17時以降）は「退場が到着を上回っている」状態であり、
 *   実際にはこの時間帯にも新規到着はゼロではない。この近似は「新規到着数」
 *   ではなく「在場率の純増分」しか捉えられないため、17時以降の到着を一律0とする。
 *   ゲート運用（開場直後の行列）を見るという目的においては、在場率が伸びる
 *   午前〜昼過ぎの挙動が主眼であり、この近似の影響は限定的
 * - 定数（lanesPerGate・personsPerLaneMin）は実測値ではなく、手荷物検査込みの
 *   運用想定値。実会場ではゲートの実測スループットで較正して置き換える前提
 */

/** model.ts の OCCUPANCY と同値の自前コピー（egress.ts と同じ自己完結方針。ズレたら両方直す） */
const OCCUPANCY: Record<number, number> = {
  11: 0.2,
  12: 0.42,
  13: 0.6,
  14: 0.75,
  15: 0.88,
  16: 0.95,
  17: 0.9,
  18: 0.82,
  19: 0.8,
  20: 0.72,
  21: 0.55,
};

/** 対象時刻。開場11時〜終演21時（model.ts の VENUE と同じ想定レンジ） */
const HOURS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] as const;

// ── 公開型 ─────────────────────────────────────────────────────────

export type GateId = "west" | "east";

const GATE_IDS: readonly GateId[] = ["west", "east"];

export type IngressAssumptions = {
  /** 1ゲートあたりのレーン数（手荷物検査を含む） */
  lanesPerGate: number;
  /** 1レーンが1分間にさばける人数 */
  personsPerLaneMin: number;
  /** west ゲートへの到着割合（0〜1）。east は 1 − splitWest */
  splitWest: number;
};

export type IngressGateHour = {
  hour: number;
  /** その時間帯にこのゲートへ到着した人数 */
  arrivals: number;
  /** その時間帯にこのゲートで処理（通過）できた人数 */
  processed: number;
  /** その時間帯終了時点の行列（繰越）人数 */
  queueEnd: number;
  /** その時間帯終了時点の待ち時間（分・小数1桁） */
  waitMin: number;
};

export type IngressResult = {
  byGate: Record<GateId, IngressGateHour[]>;
  /** 全ゲート合計の到着人数（11〜21時） */
  totalArrivals: number;
  /** 到着人数（全ゲート合計）が最大の時間帯 */
  peakHour: number;
  /** 全ゲート・全時間帯の最大待ち分 */
  maxWaitMin: number;
  maxWaitGate: GateId;
  maxWaitHour: number;
  assumptions: IngressAssumptions;
};

const DEFAULT_ASSUMPTIONS: IngressAssumptions = {
  lanesPerGate: 3,
  personsPerLaneMin: 11,
  splitWest: 0.5,
};

// ── シミュレーション ────────────────────────────────────────────────

/**
 * 入場ピークを1時間刻みで計算する。
 *
 * 各ゲート独立に待ち行列を回す（西ゲートの混雑が東ゲートへ波及することはない
 * ＝ゲートは互いに独立という単純化）。時間帯 h の処理:
 *   available   = queueEnd(h−1) + arrivals(h)
 *   processed(h) = min(available, capacity)
 *   queueEnd(h)  = max(0, available − capacity)
 *   waitMin(h)   = queueEnd(h) ÷ (capacity ÷ 60)   … 行列を裁くのに要する分数
 * capacity = lanesPerGate × personsPerLaneMin × 60（人/時）。
 *
 * 人数保存則: Σarrivals = Σprocessed + 最終時刻のqueueEnd がゲートごとに
 * 成り立つ（上の漸化式が各時間帯で arrivals + queueEnd(h−1) = processed + queueEnd(h)
 * を満たすことのテレスコーピングそのもの）。
 */
export function simulateIngress(
  tickets: number,
  opts?: Partial<IngressAssumptions>,
): IngressResult {
  if (!Number.isFinite(tickets) || tickets < 0) {
    throw new Error(`tickets は0以上の有限値であること（実際: ${tickets}）`);
  }

  const assumptions: IngressAssumptions = { ...DEFAULT_ASSUMPTIONS, ...opts };
  if (!Number.isFinite(assumptions.lanesPerGate) || assumptions.lanesPerGate <= 0) {
    throw new Error(`lanesPerGate は0より大きい有限値であること（実際: ${assumptions.lanesPerGate}）`);
  }
  if (!Number.isFinite(assumptions.personsPerLaneMin) || assumptions.personsPerLaneMin <= 0) {
    throw new Error(
      `personsPerLaneMin は0より大きい有限値であること（実際: ${assumptions.personsPerLaneMin}）`,
    );
  }
  if (
    !Number.isFinite(assumptions.splitWest) ||
    assumptions.splitWest < 0 ||
    assumptions.splitWest > 1
  ) {
    throw new Error(`splitWest は0〜1の有限値であること（実際: ${assumptions.splitWest}）`);
  }

  // 時間帯別・全ゲート合計の到着人数（在場率カーブの純増分。負は0に丸める）
  const totalArrivalsByHour: number[] = HOURS.map((h, i) => {
    const prev = i === 0 ? 0 : OCCUPANCY[HOURS[i - 1]];
    const delta = OCCUPANCY[h] - prev;
    return Math.max(0, delta) * tickets;
  });

  const capacity = assumptions.lanesPerGate * assumptions.personsPerLaneMin * 60; // 人/時
  const capacityPerMin = capacity / 60;

  const splitOf = (gate: GateId) => (gate === "west" ? assumptions.splitWest : 1 - assumptions.splitWest);

  const byGate = {} as Record<GateId, IngressGateHour[]>;
  for (const gate of GATE_IDS) {
    const split = splitOf(gate);
    let queueEnd = 0;
    const rows: IngressGateHour[] = HOURS.map((hour, i) => {
      const arrivals = totalArrivalsByHour[i] * split;
      const available = queueEnd + arrivals;
      const processed = Math.min(available, capacity);
      const newQueueEnd = Math.max(0, available - capacity);
      const waitMin = Math.round((newQueueEnd / capacityPerMin) * 10) / 10;
      queueEnd = newQueueEnd;
      return { hour, arrivals, processed, queueEnd: newQueueEnd, waitMin };
    });
    byGate[gate] = rows;
  }

  const totalArrivals = totalArrivalsByHour.reduce((s, v) => s + v, 0);

  // peakHour: 到着人数（全ゲート合計）が最大の時間帯。同値なら早い方
  let peakHour: number = HOURS[0];
  let peakVal = -Infinity;
  HOURS.forEach((h, i) => {
    if (totalArrivalsByHour[i] > peakVal) {
      peakVal = totalArrivalsByHour[i];
      peakHour = h;
    }
  });

  // maxWait: 全ゲート・全時間帯を走査。同値なら先に見つかった方（west優先・時刻昇順）
  let maxWaitMin = -Infinity;
  let maxWaitGate: GateId = "west";
  let maxWaitHour: number = HOURS[0];
  for (const gate of GATE_IDS) {
    for (const row of byGate[gate]) {
      if (row.waitMin > maxWaitMin) {
        maxWaitMin = row.waitMin;
        maxWaitGate = gate;
        maxWaitHour = row.hour;
      }
    }
  }
  if (maxWaitMin === -Infinity) maxWaitMin = 0; // tickets=0 等、常に0の場合

  return { byGate, totalArrivals, peakHour, maxWaitMin, maxWaitGate, maxWaitHour, assumptions };
}
