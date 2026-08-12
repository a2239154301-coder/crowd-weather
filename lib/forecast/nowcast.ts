/**
 * 観測統合（ナウキャスト）層 — カメラ・スタッフ報告を「予報への補正率」に変える。
 *
 * 2026-08-13 新設。予報モデル（`model.ts`）は事前計算だが、当日は現場から
 * 実況が入ってくる（定点カメラ・スタッフの混雑ボタン・無線の自由文・写真のバンド分類）。
 * その実況を予報に**上書きせず**、補正率として掛ける形にするのがこの層の設計。
 *
 * ## なぜ上書きではなく補正率なのか
 *
 * 観測は点でしか来ない。観測が途絶えた瞬間に予報へ滑らかに戻したいので、
 * 「観測値そのもの」ではなく「予報とのずれ（factor）」を持ち、
 * 時間とともに factor を 1 に減衰させる（3時間で完全に予報へ回帰）。
 * 観測の絶対値を持ち回ると、古い観測が予報より信用され続ける事故が起きる。
 *
 * ## なぜ食い違い時は最大値なのか（安全側の核心）
 *
 * カメラ=60 とスタッフ=90 が同時に来たとき、平均の75を出すと両方の顔を立てて
 * どちらの現実にも合わない数字になる。雑踏警備では「実は90だった」を見落とす方が
 * 致命的なので、**高い方を信じて conflict フラグで無線確認を促す**。
 * 数字は安全側に倒し、確認は人がやる——この役割分担が本製品の安全設計。
 *
 * ## このファイルの立ち位置
 *
 * 純関数のみ・他モジュールへの依存なし・LLM不使用。
 * 既存の計算層（`model.ts` / `risk.ts`）には1行も手を入れず、
 * 予報値 → correctedDensity() で補正するだけの追加層として使う。
 */

export type ObservationSource = "camera" | "staff-button" | "staff-text" | "photo";

export type Observation = {
  zoneId: string;
  /** 観測時刻（0時からの分） */
  minutes: number;
  /** 観測が示す混雑指数 0-100 */
  impliedDensity: number;
  source: ObservationSource;
};

/**
 * 信頼度重み。カメラ実測 > ボタン報告 > 自由文由来 > 写真バンド分類。
 * カメラは機械計数で最も客観的。ボタンは人の判断だが選択肢が固定。
 * 自由文は言い回しの解釈が入り、写真はバンド（帯）への分類なので分解能が最も粗い。
 */
export const SOURCE_WEIGHT: Record<ObservationSource, number> = {
  camera: 1.0,
  "staff-button": 0.8,
  "staff-text": 0.6,
  photo: 0.5,
};

/**
 * 観測を採用する鮮度の上限（分）。3時間より古い実況は「いま」の根拠にしない。
 * correctionFactor の減衰も同じ180分で予報に完全回帰させ、時定数を1つに揃える
 * （採用窓と減衰窓がズレると「採用されたのに全く効かない」帯域が広がって説明しづらい）。
 */
const MAX_AGE_MINUTES = 180;

/**
 * 食い違い判定のしきい値。混雑指数の帯1つ分（約25）以上ズレたら
 * 「別の現実を見ている」とみなし、平均でならさず安全側に倒す。
 */
const CONFLICT_SPREAD = 25;

/** clamp。依存を持たない層なので自前で持つ */
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export type Fusion = {
  zoneId: string;
  /** 統合後の観測混雑指数。観測が無ければ null */
  fusedDensity: number | null;
  /** 観測同士が食い違っているか（採用観測のmax-min >= 25） */
  conflict: boolean;
  usedCount: number;
  latestMinutes: number | null;
};

/**
 * ゾーンの観測を1つの混雑指数に統合する。
 *
 * 採用条件: zoneId 一致、かつ age = nowMinutes - minutes が 0以上180分以内。
 * 未来の観測（age < 0）は時刻の打ち間違いとみなして採用しない。
 *
 * 重み = SOURCE_WEIGHT × (1 - age/180)。鮮度は線形減衰
 * （指数減衰にしない理由: 180分で正確に0になり採用窓と一致する。
 * 現場に「3時間で効かなくなる」と一言で説明できることを優先した）。
 *
 * conflict（max-min >= 25）のときは加重平均ではなく**採用観測の最大値**。
 * 理由はファイル冒頭の「なぜ食い違い時は最大値なのか」を参照。
 * 食い違い判定は重み適用前の生の値で行う——弱いソースの「90」を
 * 重みで薄めてから比較すると、食い違いそのものが見えなくなるため。
 */
export function fuseObservations(obs: Observation[], zoneId: string, nowMinutes: number): Fusion {
  const adopted = obs.filter((o) => {
    if (o.zoneId !== zoneId) return false;
    const age = nowMinutes - o.minutes;
    return age >= 0 && age <= MAX_AGE_MINUTES;
  });

  if (adopted.length === 0) {
    return { zoneId, fusedDensity: null, conflict: false, usedCount: 0, latestMinutes: null };
  }

  const values = adopted.map((o) => o.impliedDensity);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const conflict = max - min >= CONFLICT_SPREAD;

  let fused: number;
  if (conflict) {
    fused = max;
  } else {
    let weightSum = 0;
    let valueSum = 0;
    for (const o of adopted) {
      const age = nowMinutes - o.minutes;
      const w = SOURCE_WEIGHT[o.source] * (1 - age / MAX_AGE_MINUTES);
      weightSum += w;
      valueSum += w * o.impliedDensity;
    }
    // weightSum === 0 は全観測が age ちょうど180分のときだけ起きる。
    // 鮮度の情報が完全に失われているので conflict 時と同じ安全側（最大値）に倒す。
    // NaN を出さないためのガードであり、値の妙味はない
    // （この鮮度では correctionFactor が 1 を返すので下流にはほぼ効かない）。
    fused = weightSum > 0 ? valueSum / weightSum : max;
  }

  return {
    zoneId,
    fusedDensity: Math.round(fused),
    conflict,
    usedCount: adopted.length,
    latestMinutes: Math.max(...adopted.map((o) => o.minutes)),
  };
}

/**
 * 予測混雑指数への補正率。
 *
 * - 観測なし（fused = null）または predicted <= 0 なら 1（補正しない）。
 *   predicted が 0 のときに比率を作ると発散するので、観測があっても触らない。
 * - raw = clamp(fused/predicted, 0.5, 2.0)。観測1点で予報を半分未満/2倍超に
 *   動かさない——観測にも誤りはあり、モデル全体を1点で否定させないための箍（たが）。
 * - factor = 1 + (raw - 1) × max(0, 1 - ageMinutes/180)。
 *   観測が古くなるほど 1 に線形回帰し、3時間で予報値に完全に戻る。
 *   ageMinutes は「現在時刻 − 最新観測時刻」（= nowMinutes − latestMinutes）。
 */
export function correctionFactor(
  fusedDensity: number | null,
  predicted: number,
  ageMinutes: number
): number {
  if (fusedDensity === null || predicted <= 0) return 1;
  const raw = clamp(fusedDensity / predicted, 0.5, 2.0);
  return 1 + (raw - 1) * Math.max(0, 1 - ageMinutes / MAX_AGE_MINUTES);
}

/**
 * 補正後の混雑指数。指数の定義域 0-100 に収めて丸める
 * （factor 2.0 × predicted 60 = 120 のような定義域超えをここで畳む）。
 */
export function correctedDensity(predicted: number, factor: number): number {
  return clamp(Math.round(predicted * factor), 0, 100);
}
