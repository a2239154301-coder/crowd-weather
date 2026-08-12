import type { Band } from "./scales";
import { DENSITY_BANDS, densityBand, wbgtBand } from "./scales";
import type { Scenario, Severity, Zone, ZoneForecast } from "./types";
import { forecastZones } from "./model";
import { HOURS, VENUE } from "./venue";

/**
 * 総合リスク予報 —「これから危なくなる場所」を出す層。
 *
 * 2026-08-12 新設。企画書スライド14-15の主張（既存サービスは「いま混んでいる場所」を
 * 教えてくれるが、警備計画に必要なのは「これから危なくなる場所」）を、
 * そのまま画面に出すための計算。
 *
 * ## なぜ暑熱を主指標にしないのか（この設計の核心）
 *
 * 既定条件（34℃・晴れ）で `wbgtPhysical` を回すと、日陰でないゾーンのWBGTは
 * **11:00〜17:00 のあいだずっと31℃以上＝最上位帯に貼りつく**。
 * つまり暑熱を主指標にする限り、時刻を変えても全面が最上位帯のまま動かない。
 * 「ヒートマップの動きが見えない」の原因は色の量子化ではなく、これ。
 *
 * そこで判定は **混雑が主・暑熱が一段押し上げる** 形にする:
 *
 *     riskSeverity = min(3, dSev + (wSev === 3 ? 1 : 0))
 *
 * 根拠は企画書POINT01が挙げる事故そのもの。梨泰院159名も明石11名も密度側の事故で、
 * 暑熱だけの地図では企画書の主張を支えられない。暑熱は単独で雑踏事故を起こさないが、
 * 同じ密度の危険度は確実に一段上げる。
 *
 * ## このファイルの立ち位置
 *
 * 既存の計算層（`model.ts` / `wbgt.ts` / `heatfield.ts`）は**1行も変更していない**。
 * ここは `forecastZones()` の出力を読んで組み替えるだけの純粋な追加層で、
 * LLMも使わない。新しい物理モデルは持ち込んでいない。
 */

/**
 * 危険帯に入るまでの残り時間の段階色。
 *
 * `DENSITY_BANDS` の4色を**同じ重篤度順でそのまま流用**する。
 * 2026-08-09 のΔE検証（隣接16.6／色覚型8.9）がそのまま有効になり、
 * 現場から見ても「赤はいつもいちばん危ない」で読み方が変わらない。
 * 色を新調しないこと自体が設計判断なので、`DENSITY_BANDS` から参照して固定する。
 */
export const TIME_BANDS: Band[] = [
  { severity: 0, label: "当面安全", short: "安", color: DENSITY_BANDS[0].color },
  { severity: 1, label: "3時間以内", short: "3h", color: DENSITY_BANDS[1].color },
  { severity: 2, label: "1時間以内", short: "1h", color: DENSITY_BANDS[2].color },
  { severity: 3, label: "いま危険", short: "危", color: DENSITY_BANDS[3].color },
];

/** 危険の要因。打ち手が変わるので「なぜ危険か」は必ず持ち回る（混雑→誘導 / 暑熱→ミスト・給水） */
export type RiskCause = "混雑" | "混雑＋暑熱" | "暑熱" | null;

/**
 * 混雑と暑熱を合成した総合リスク。混雑が主、暑熱が一段押し上げる。
 * しきい値そのものは `densityBand` / `wbgtBand`（＝環境省区分）に委ねる。
 */
export function riskSeverity(density: number, wbgt: number): Severity {
  const d = densityBand(density).severity;
  const w = wbgtBand(wbgt).severity;
  return Math.min(3, d + (w === 3 ? 1 : 0)) as Severity;
}

/**
 * その危険が何によるものか。
 * 暑熱が押し上げに寄与しているときだけ「＋暑熱」を出す（常時出すと意味が薄れる）。
 */
export function riskCause(density: number, wbgt: number): RiskCause {
  const d = densityBand(density).severity;
  const w = wbgtBand(wbgt).severity;
  if (d === 0 && w < 3) return null;
  if (d === 0) return "暑熱";
  if (w === 3) return d >= 3 ? "混雑" : "混雑＋暑熱";
  return "混雑";
}

/** ある時刻のゾーンのリスク。`ZoneForecast` に「この先」を足したもの */
export type ZoneRisk = ZoneForecast & {
  /** いまの総合リスク */
  severity: Severity;
  cause: RiskCause;
  /** 危険（severity 3）になるまでの時間。null = 終演まで危険にならない */
  hoursToDanger: number | null;
  /** 危険になる時刻。表示は「17:00 危険」の形にする（相対時間より現場で使える） */
  dangerHour: number | null;
  /** 危険時点の要因。いま危険でないゾーンの打ち手を先回りで決めるために持つ */
  dangerCause: RiskCause;
  /**
   * 危険になる**その時刻の**混雑指数とWBGT。
   * いまの値ではない。「17:00に物販の列が混雑88まで上がる」と言えることが
   * この製品の主張なので、予報値のほうを持ち回る
   */
  dangerDensity: number | null;
  dangerWbgt: number | null;
};

/**
 * 指定時刻のゾーン別リスクと、危険帯に入るまでの残り時間。
 *
 * `hour` 以降の各時刻で `forecastZones()` を呼ぶ。計算量は `dayPlan()` と同等
 * （18ゾーン × 最大11時刻 × 日陰7x7サンプル）なので、呼び出し側の useMemo で足りる。
 */
export function zoneRisks(zones: Zone[], hour: number, s: Scenario): ZoneRisk[] {
  const future = HOURS.filter((h) => h >= hour);
  // 時刻ごとに1回だけ計算する（forecastZones は内部で影多角形を時刻ごとに1回にまとめている）
  const byHour = future.map((h) => ({ hour: h, forecast: forecastZones(zones, h, s) }));
  const now = byHour[0]?.forecast ?? forecastZones(zones, hour, s);

  return now.map((f, i) => {
    let hoursToDanger: number | null = null;
    let dangerHour: number | null = null;
    let dangerCause: RiskCause = null;
    let dangerDensity: number | null = null;
    let dangerWbgt: number | null = null;

    for (const step of byHour) {
      const g = step.forecast[i];
      if (riskSeverity(g.density, g.wbgt) === 3) {
        hoursToDanger = step.hour - hour;
        dangerHour = step.hour;
        dangerCause = riskCause(g.density, g.wbgt);
        dangerDensity = g.density;
        dangerWbgt = g.wbgt;
        break;
      }
    }

    return {
      ...f,
      severity: riskSeverity(f.density, f.wbgt),
      cause: riskCause(f.density, f.wbgt),
      hoursToDanger,
      dangerHour,
      dangerCause,
      dangerDensity,
      dangerWbgt,
    };
  });
}

/**
 * 残り時間 → 段階色。
 * 4時間以上先と「終演まで危険にならない」を同じ緑に畳む。
 * 現場の判断単位は「いま／まもなく／今日のうち／当面なし」の4つで足りる。
 */
export function timeBand(hoursToDanger: number | null): Band {
  if (hoursToDanger === null) return TIME_BANDS[0];
  if (hoursToDanger <= 0) return TIME_BANDS[3];
  if (hoursToDanger <= 1) return TIME_BANDS[2];
  if (hoursToDanger <= 3) return TIME_BANDS[1];
  return TIME_BANDS[0];
}

/** 地図に出す一言。「いま危険」/「17:00 危険」/「安全」 */
export function riskLabel(r: ZoneRisk): string {
  if (r.hoursToDanger === null) return "安全";
  if (r.hoursToDanger <= 0) return "いま危険";
  return `${r.dangerHour}:00 危険`;
}

/**
 * 危険の到来順。いま危険なものが先、その後は危険になる時刻の早い順。
 * 同時刻なら混雑指数の高い順（先に手を打つべきほうを上に）。
 * 終演まで危険にならないゾーンは落とす。
 */
export function arrivalOrder(risks: ZoneRisk[]): ZoneRisk[] {
  return risks
    .filter((r) => r.hoursToDanger !== null)
    .slice()
    .sort((a, b) => {
      const d = (a.hoursToDanger ?? 0) - (b.hoursToDanger ?? 0);
      if (d !== 0) return d;
      return b.density - a.density;
    });
}

/** 一日を通していちばん早く危険になるゾーン。開場前の準備で最初に見る値 */
export function firstDanger(
  zones: Zone[],
  s: Scenario
): { zone: Zone; hour: number; cause: RiskCause } | null {
  for (const h of HOURS) {
    const fc = forecastZones(zones, h, s);
    const hit = fc
      .filter((f) => riskSeverity(f.density, f.wbgt) === 3)
      .sort((a, b) => b.density - a.density)[0];
    if (hit) return { zone: hit.zone, hour: h, cause: riskCause(hit.density, hit.wbgt) };
  }
  return null;
}

/** 会場の全ゾーン（会場内＋会場外）。危険は境界をまたいで移動するので、リスク表示は分けない */
export const ALL_ZONES: Zone[] = VENUE.zones;
