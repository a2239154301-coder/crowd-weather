/**
 * 退場波及モデル（ネットワーク流＋待ち行列・1分刻み・決定的）。
 *
 * 終演でメインステージから吐き出された観客が、容量制限のある退場経路網
 * （会場→駅・バス・商店街・大通り）を流れて系外へはけるまでを計算する。
 * 「規制退場（分割リリース）が下流のピークをどれだけ下げるか」を
 * 数字で示すのがこのモジュールの存在理由。
 *
 * 設計方針:
 * - LLM不使用・完全決定的。同じ入力は常に同じ出力（このリポジトリの文化。
 *   雑踏の安全に関わる数字が実行のたびに変わってはならない）
 * - 他モジュールをimportしない自己完結。ネットワーク定義もここに閉じる
 *   （退場経路網は会場図のゾーンとは別レイヤーの概念であり、venue.ts の
 *   ゾーングラフと混ぜると双方の変更が絡み合うため）
 * - 1分刻みの同期更新（各分の流量はすべて「分頭の滞留」から計算してから
 *   一斉に適用する）。ノードの処理順に結果が依存しない＝決定性の担保であり、
 *   1分に1エッジぶんしか進めないという歩行速度の粗い近似にもなっている
 */

// ── ネットワーク定義（デモ会場の退場経路。幅はすべて想定値） ──────────

/**
 * ノードID。plat / alley / blvd / bus は吸収ノード
 * （入った人はその分のうちに系外へ出る＝駅ホームに乗車、街へ分散、乗車待機）。
 */
const NODE_IDS = ["main", "exit", "plaza", "conc", "plat", "alley", "blvd", "bus"] as const;

type NodeId = (typeof NODE_IDS)[number];

const ABSORBING: ReadonlySet<NodeId> = new Set<NodeId>(["plat", "alley", "blvd", "bus"]);

/**
 * 流動係数 60人/分/m。
 * 出典: J.J. Fruin『Pedestrian Planning and Design』の歩行路の上限
 * （約82人/分/m）を安全側に丸めた実用値。原典の実測ではなく雑踏警備関連の
 * 二次資料に基づく想定値であり、実会場ではカメラ実測で較正して置き換える前提。
 */
const FLOW_PER_M = 60;

type Edge = {
  to: NodeId;
  /** 経路幅（m）。想定値。エッジ容量 = 幅 × FLOW_PER_M（人/分） */
  widthM: number;
  /** 分岐比率。同一ノードの出エッジで合計1になる（人の行き先の想定割合） */
  ratio: number;
};

/**
 * 退場経路網。デモ会場の想定レイアウト:
 * メインステージ → 退場動線 → 駅前広場で三方向（改札コンコース→駅ホーム／
 * 商店街／大通り）に分岐。退場動線からはバス待機列も分岐する。
 */
const EDGES: Record<NodeId, Edge[]> = {
  main: [{ to: "exit", widthM: 24, ratio: 1 }],
  exit: [
    { to: "plaza", widthM: 14, ratio: 0.85 },
    { to: "bus", widthM: 6, ratio: 0.15 },
  ],
  plaza: [
    { to: "conc", widthM: 10, ratio: 0.6 },
    { to: "alley", widthM: 4, ratio: 0.15 },
    { to: "blvd", widthM: 8, ratio: 0.25 },
  ],
  conc: [{ to: "plat", widthM: 8, ratio: 1 }],
  // 吸収ノードは出エッジなし（系外へ抜ける）
  plat: [],
  alley: [],
  blvd: [],
  bus: [],
};

function capacityOf(e: Edge): number {
  return e.widthM * FLOW_PER_M;
}

// ── 公開型 ─────────────────────────────────────────────────────────

/** 放出の波。atMin 分に attendees × fraction 人を main に投入する */
export type ReleaseWave = { atMin: number; fraction: number };

export type EgressParams = { attendees: number; releaseWaves: ReleaseWave[] };

export type NodePeak = { value: number; atMin: number };

export type EgressResult = {
  /** ノードID → 1分刻みの滞留人数（シミュレーション長ぶん） */
  series: Record<string, number[]>;
  peak: Record<string, NodePeak>;
  /** 系内（吸収ノード以外）の滞留が attendees の1%未満になる分 */
  clearMin: number;
};

// ── シミュレーション ────────────────────────────────────────────────

/** 打ち切り上限（分）。これを超えて滞留が残るならモデルか入力が壊れている */
const MAX_MIN = 240;

/**
 * 退場波及を1分刻みで計算する。
 *
 * 各分の処理:
 * 1. atMin がその分の波を main に投入
 * 2. 各ノードの流量 = min(滞留, 出エッジ容量合計) を分岐比率で配分。
 *    ただし各エッジは自分の容量（幅×60人/分）を超えない。容量で弾かれた分は
 *    そのノードに滞留し続ける（＝上流に詰まりが波及する仕組みそのもの）
 * 3. 全ノード同時に適用（同期更新）。吸収ノードは入った人をそのまま系外へ
 *    出し、series には「その分に入ってきた人数」を記録する（ピーク観察用）
 *
 * 人数保存則: 放出済み合計 = 系内滞留 + 系外流出累計 が毎分成り立つ
 * （浮動小数の丸め誤差を除く。人数は連続量として扱う流体近似）。
 */
export function simulateEgress(params: EgressParams): EgressResult {
  const { attendees, releaseWaves } = params;

  // 入力検証。fraction 合計≠1 は「観客が消える/湧く」を意味し、
  // 人数保存則が最初から破れるので黙って補正せずエラーにする
  if (!Number.isFinite(attendees) || attendees < 0) {
    throw new Error(`attendees は0以上の有限値であること（実際: ${attendees}）`);
  }
  const fractionSum = releaseWaves.reduce((s, w) => s + w.fraction, 0);
  // 許容誤差 1e-9: 1/3 × 3 のような浮動小数の和を正しく1と認めるため
  if (Math.abs(fractionSum - 1) > 1e-9) {
    throw new Error(`releaseWaves の fraction 合計は1であること（実際: ${fractionSum}）`);
  }
  for (const w of releaseWaves) {
    if (!Number.isInteger(w.atMin) || w.atMin < 0 || w.atMin >= MAX_MIN) {
      throw new Error(`atMin は 0〜${MAX_MIN - 1} の整数であること（実際: ${w.atMin}）`);
    }
    if (w.fraction < 0) {
      throw new Error(`fraction は0以上であること（実際: ${w.fraction}）`);
    }
  }

  const stock = {} as Record<NodeId, number>;
  const series = {} as Record<NodeId, number[]>;
  for (const n of NODE_IDS) {
    stock[n] = 0;
    series[n] = [];
  }

  let clearMin = Infinity;

  for (let t = 0; t < MAX_MIN; t++) {
    // 1) 放出: この分に当たる波を main へ投入
    for (const w of releaseWaves) {
      if (w.atMin === t) stock.main += attendees * w.fraction;
    }

    // 2) 流量計算: すべて「分頭の滞留」から求める（同期更新の前半）
    const inflow = {} as Record<NodeId, number>;
    const outflow = {} as Record<NodeId, number>;
    for (const n of NODE_IDS) {
      inflow[n] = 0;
      outflow[n] = 0;
    }
    for (const from of NODE_IDS) {
      const edges = EDGES[from];
      if (edges.length === 0) continue;
      const totalCap = edges.reduce((s, e) => s + capacityOf(e), 0);
      const flow = Math.min(stock[from], totalCap);
      for (const e of edges) {
        // 分岐比率で配分しつつ、各エッジ自身の容量でキャップする。
        // キャップで送れなかった分は from に残る（再配分はしない: 現場では
        // 行き先の希望は分岐比率で決まっており、詰まったからといって
        // 別方向へ即座に流れはしない、という保守的な仮定）
        const f = Math.min(flow * e.ratio, capacityOf(e));
        outflow[from] += f;
        inflow[e.to] += f;
      }
    }

    // 3) 同時適用と記録
    let inSystem = 0;
    for (const n of NODE_IDS) {
      if (ABSORBING.has(n)) {
        // 吸収ノード: 滞留させず系外へ。series はその分の流入人数
        // （＝ホーム・街路が1分間に受ける人数。ピーク観察用）
        series[n].push(inflow[n]);
      } else {
        stock[n] = stock[n] - outflow[n] + inflow[n];
        series[n].push(stock[n]);
        inSystem += stock[n];
      }
    }

    // 4) はけ判定。未放出の波が残る間は「はけた」と見なさない
    //    （規制退場では波の合間に系内が一時的に空になるため、この条件が
    //     ないと clearMin が不当に早く確定してしまう）。
    //    attendees === 0 の特例: 閾値 0 との「未満」比較は永遠に偽になるので
    //    即時はけ扱いにする
    const allReleased = releaseWaves.every((w) => w.atMin <= t);
    if (allReleased && (inSystem < attendees * 0.01 || attendees === 0)) {
      clearMin = t;
      break;
    }
  }

  // ピーク: 最大値と、それが最初に出た分（同値なら早い方＝規制のかけ始めに使う）
  const peak = {} as Record<NodeId, NodePeak>;
  for (const n of NODE_IDS) {
    let best: NodePeak = { value: 0, atMin: 0 };
    const s = series[n];
    for (let i = 0; i < s.length; i++) {
      if (s[i] > best.value) best = { value: s[i], atMin: i };
    }
    peak[n] = best;
  }

  return { series, peak, clearMin };
}

// ── シナリオ生成 ────────────────────────────────────────────────────

/**
 * 終演時在場率 0.55。model.ts の OCCUPANCY[21]（終演時刻21時の在場率）と
 * 同じ値。終演前に帰り始める客が一定数いるため、退場波及の初期人数は
 * 「チケット販売数 × 終演時在場率」で見積もる。
 * （model.ts を import しないのは自己完結の方針のため。値がずれたら
 * こちらのコメントと model.ts の両方を直すこと）
 */
const CLOSING_OCCUPANCY = 0.55;

/** 一斉退場（規制なし）: 終演と同時に全員が動き出す最悪ケース */
export function defaultEgress(tickets: number): EgressParams {
  return {
    attendees: Math.round(tickets * CLOSING_OCCUPANCY),
    releaseWaves: [{ atMin: 0, fraction: 1 }],
  };
}

/**
 * 規制退場: 10分間隔の3分割リリース（ブロックごとの退場アナウンス運用を想定）。
 * ピークを下げる代わりに、はけ切りは一斉退場より遅くなるトレードオフを持つ
 */
export function regulatedEgress(tickets: number): EgressParams {
  return {
    attendees: Math.round(tickets * CLOSING_OCCUPANCY),
    releaseWaves: [
      { atMin: 0, fraction: 1 / 3 },
      { atMin: 10, fraction: 1 / 3 },
      { atMin: 20, fraction: 1 / 3 },
    ],
  };
}
