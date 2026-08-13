"use client";

import { useEffect, useMemo, useState } from "react";
import type { Scenario, Weather } from "@/lib/forecast/types";
import { VENUE, DEFAULT_SCENARIO, HOURS } from "@/lib/forecast/venue";
import { centroid, dayPlan, hourPeak } from "@/lib/forecast/model";
import { fetchLiveWeather, geocode } from "@/lib/weather/open-meteo";
import HourlyStrip from "./hourly-strip";
import ZoneTimeline from "./zone-timeline";
import ArrivalList from "./arrival-list";
import EntryPeak from "./entry-peak";
import { densityBand, wbgtBand } from "@/lib/forecast/scales";
import { useTheme } from "@/lib/ui/theme";
import { arrivalOrder, venuePeakHour, zoneRisks } from "@/lib/forecast/risk";
import { costYenForMeta, formatYen } from "@/lib/ai/pricing";
import VenueMap, { type MapLayer, type StaffMark } from "./venue-map";
import SourceTag from "./source-tag";
import { useScenario } from "@/lib/ui/scenario-context";
import { postsFor, postsToMarks } from "@/lib/ops/staffing";

const WEATHER_LABEL: Record<Weather, string> = { sunny: "晴", cloudy: "曇", rainy: "雨" };
const WEATHER_GLYPH: Record<Weather, string> = { sunny: "☀", cloudy: "☁", rainy: "☂" };

type AiMeta = {
  servedModel: string;
  requestedModel: string;
  fallbackLevel: number;
  /** orcarouter/{name} を呼んだときだけ入る（X-Orca-Router / X-Orca-Resolved-Model） */
  router: string | null;
  resolvedModel: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
};

export default function OpsConsole() {
  const { T, sem, name } = useTheme();
  // 予報条件は全モード共有（計画で変えれば当日・計画書にもそのまま効く）
  const { scenario, setScenario, set } = useScenario();
  const [hour, setHour] = useState(15);
  const [layer, setLayer] = useState<MapLayer>("crowd");

  // NOWバッジ用の実時刻。SSRとの不一致を避けるためマウント後に取得。
  // 開催時間外は null（クランプすると朝9時に「11:00がNOW」と誤表示になる）
  const [clockHour, setClockHour] = useState<number | null>(null);
  useEffect(() => {
    const h = new Date().getHours();
    setClockHour(h >= VENUE.open && h <= VENUE.close ? h : null);
  }, []);
  // PEAKバッジ用: 会場全体（内＋外）の危険度合計が最大になる時刻
  const peak = useMemo(() => venuePeakHour(VENUE.zones, scenario), [scenario]);

  // Open-Meteo 実況（LIVE）。null=手入力のまま / "HH:MM"=実況反映済み / "error"
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveAt, setLiveAt] = useState<string | null>(null);

  // 会場の場所（地名 → 緯度経度）。実況の取得先と太陽位置の両方に効く
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeError, setPlaceError] = useState("");

  async function applyPlace() {
    const q = placeQuery.trim();
    if (!q || placeBusy) return;
    setPlaceBusy(true);
    setPlaceError("");
    try {
      const hits = await geocode(q);
      if (hits.length === 0) {
        setPlaceError(`「${q}」が見つかりませんでした`);
        return;
      }
      const g = hits[0];
      setScenario((p) => ({ ...p, geo: { name: g.name, lat: g.lat, lon: g.lon } }));
      setPlaceQuery("");
      setLiveAt(null);
    } catch {
      setPlaceError("場所を取得できませんでした");
    } finally {
      setPlaceBusy(false);
    }
  }

  async function applyLive() {
    if (liveBusy) return;
    setLiveBusy(true);
    setLiveAt(null);
    try {
      const live = await fetchLiveWeather({ lat: scenario.geo.lat, lon: scenario.geo.lon });
      setScenario((p) => ({
        ...p,
        weather: live.weather,
        temp: live.tempC,
        rhPct: live.rhPct,
        windMs: live.windMs,
        date: live.date,
      }));
      // 実況時刻をタイムラインへ（開場前・終演後は端にクランプ）
      const h = Math.round(live.minutes / 60);
      setHour(Math.max(VENUE.open, Math.min(VENUE.close, h)));
      setLiveAt(live.timeLabel);
    } catch {
      setLiveAt("error");
    } finally {
      setLiveBusy(false);
    }
  }

  const [advice, setAdvice] = useState("");
  const [adviceLabel, setAdviceLabel] = useState("");
  const [aiMeta, setAiMeta] = useState<(AiMeta & { latencyMs: number }) | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [easyStyle, setEasyStyle] = useState(false);

  // リスク予報レイヤーが「会場内＋会場外」合算だった前提を、2026-08-14に全画面へ統一した
  // （再設計 §2-2）。危険は終演時に退場動線 → 駅前広場 → 改札 → ホーム と境界をまたいで
  // 移るので、分けると話が切れる。画面・統計・AIへ渡す予報は、すべてこの zones に揃える
  const zones = VENUE.zones;
  const scopeLabel = "会場内＋会場外";

  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const now = useMemo(() => hourPeak(zones, hour, scenario), [zones, hour, scenario]);

  // 到来順は常設表示（ZoneTimeline直下）になったのでレイヤーに関係なく計算する。
  // 対象は常に会場内＋会場外の全ゾーン（scope切替の影響を受けない）
  const risks = useMemo(() => zoneRisks(VENUE.zones, hour, scenario), [hour, scenario]);
  const arrivals = useMemo(() => arrivalOrder(risks), [risks]);

  const dayBand = densityBand(plan.peakDensity);
  const heatBand = wbgtBand(plan.peakWbgt);

  // 配置ポスト（lib/ops/staffing.ts）。地図にはポストコード付きマークとして出す
  const staff: StaffMark[] = useMemo(() => postsToMarks(postsFor(plan)), [plan]);

  /** LLMに渡す予報スナップショット。数値はすべて計算エンジンの出力 */
  function forecastPayload() {
    // 指示書モード用: この後3時間の時間帯別ピーク（未来が分かるのが本製品の価値）
    const outlook = HOURS.filter((h) => h > hour && h <= hour + 3).map((h) => {
      const p = hourPeak(zones, h, scenario);
      return {
        hour: h,
        maxCrowd: p.maxDensity,
        maxCrowdZone: p.maxDensityZone.name,
        maxWBGT: p.maxWbgt,
        maxWBGTZone: p.maxWbgtZone.name,
      };
    });
    return {
      venue: VENUE.name,
      hour,
      scope: scopeLabel,
      weather: WEATHER_LABEL[scenario.weather],
      temp: scenario.temp,
      humidity: scenario.rhPct,
      windMs: scenario.windMs,
      tickets: scenario.tickets,
      current: {
        maxCrowd: now.maxDensity,
        maxCrowdZone: now.maxDensityZone.name,
        maxWBGT: now.maxWbgt,
        maxWBGTZone: now.maxWbgtZone.name,
        shadeRate: now.shadeRate,
      },
      outlook,
      dayPlan: {
        peakCrowd: plan.peakDensity,
        peakCrowdHour: plan.peakDensityHour,
        peakCrowdZone: plan.peakDensityZone.name,
        peakWBGT: plan.peakWbgt,
        peakWBGTHour: plan.peakWbgtHour,
        tents: plan.tents,
      },
    };
  }

  async function askOrca(mode: "advice" | "directive") {
    setAiBusy(true);
    setAdvice("");
    setAdviceLabel(mode === "directive" ? "運営指示書（AI起草）" : "運営判断の提案");
    setAiMeta(null);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          style: easyStyle ? "easy" : "standard",
          forecast: forecastPayload(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "AI request failed");
      setAdvice(data.text || "提案を取得できませんでした。");
      setAiMeta({ ...(data.meta as AiMeta), latencyMs: Date.now() - t0 });
    } catch {
      setAdvice(
        "AI提案を取得できませんでした。ORCAROUTER_API_KEY を確認してください（ローカルは .env.local、本番は Vercel の環境変数）。"
      );
    } finally {
      setAiBusy(false);
    }
  }

  // ── 多声ブリーフィング（同じ予報を2系統に書き分け・並列生成） ──
  // 2026-08-14、予報コンソールはディレクター向け・スタッフ向けの情報のみにする方針で
  // 来場者向けを外した（再設計 §2-3）。来場者向けプロンプトはサーバー側に残しており、
  // 来場者ページへ移すときに再利用する（lib/ai/prompts.ts の visitor system prompt）。
  type Brief = { text: string; meta: (AiMeta & { latencyMs: number }) | null; error?: boolean };
  const [briefs, setBriefs] = useState<Record<string, Brief> | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);

  async function askBriefings() {
    setBriefBusy(true);
    setBriefs(null);
    const audiences = [
      ["responsible", "警備責任者"],
      ["staff", "現場スタッフ"],
    ] as const;
    const payload = forecastPayload();
    const results: Record<string, Brief> = {};
    await Promise.all(
      audiences.map(async ([key]) => {
        const t0 = Date.now();
        try {
          const res = await fetch("/api/advice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audience: key, forecast: payload }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error);
          results[key] = { text: data.text, meta: { ...(data.meta as AiMeta), latencyMs: Date.now() - t0 } };
        } catch {
          results[key] = { text: "取得できませんでした", meta: null, error: true };
        }
      })
    );
    setBriefs(results);
    setBriefBusy(false);
  }

  // ── What-if 自然言語シナリオ ──────────────────────
  const [whatifQ, setWhatifQ] = useState("");
  const [whatifBusy, setWhatifBusy] = useState(false);
  const [whatif, setWhatif] = useState<null | {
    interpretation: string;
    feasible: boolean;
    scenario: Scenario;
    hour: number;
    meta: AiMeta & { latencyMs: number };
  }>(null);
  const [whatifError, setWhatifError] = useState("");

  async function askWhatif() {
    if (!whatifQ.trim() || whatifBusy) return;
    setWhatifBusy(true);
    setWhatif(null);
    setWhatifError("");
    const t0 = Date.now();
    try {
      const res = await fetch("/api/whatif", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: whatifQ, scenario }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      // 「変更なし」はセンチネル値: weather="keep" / 数値=-1（API側のスキーマ制約に合わせる）
      const r = data.result as {
        changes: {
          weather: Scenario["weather"] | "keep";
          temp: number;
          rhPct: number;
          windMs: number;
          tickets: number;
          hour: number;
        };
        interpretation: string;
        feasible: boolean;
      };
      const c = r.changes;
      const next: Scenario = {
        ...scenario,
        ...(c.weather !== "keep" ? { weather: c.weather } : {}),
        ...(c.temp > 0 ? { temp: c.temp } : {}),
        ...(c.rhPct > 0 ? { rhPct: c.rhPct } : {}),
        ...(c.windMs > 0 ? { windMs: c.windMs } : {}),
        ...(c.tickets > 0 ? { tickets: c.tickets } : {}),
      };
      setWhatif({
        interpretation: r.interpretation,
        feasible: r.feasible,
        scenario: next,
        hour: c.hour > 0 ? c.hour : hour,
        meta: { ...(data.meta as AiMeta), latencyMs: Date.now() - t0 },
      });
    } catch (e) {
      setWhatifError(e instanceof Error && e.message ? e.message : "解釈に失敗しました");
    } finally {
      setWhatifBusy(false);
    }
  }

  // What-if 比較はエンジンの再計算で出す（LLMは数字を作らない）
  const whatifPlan = useMemo(
    () => (whatif && whatif.feasible ? dayPlan(whatif.scenario) : null),
    [whatif]
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ── 状態バー ─────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          padding: "11px 16px",
          background: T.surface,
          border: `1px solid ${T.line}`,
          borderLeft: `3px solid ${dayBand.color}`,
          borderRadius: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, color: T.textFaint, letterSpacing: 1 }}>本日の最大警戒</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            {/* 段階色は左の帯（borderLeft）で示す。文字は墨色（§3-4: 白地でdayBand.colorは軒並み4.5:1未満） */}
            <span style={{ fontSize: 19, fontWeight: 700, color: T.text }}>
              混雑 {dayBand.label}
            </span>
            <span className="cw-mono" style={{ fontSize: 13, color: T.textDim }}>
              {plan.peakDensity} / {plan.peakDensityHour}:00 {plan.peakDensityZone.name}
            </span>
          </div>
        </div>
        <div style={{ width: 1, height: 32, background: T.line }} />
        <div>
          <div style={{ fontSize: 13, color: T.textFaint, letterSpacing: 1 }}>暑熱</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: T.text }}>{heatBand.label}</span>
            <span className="cw-mono" style={{ fontSize: 13, color: T.textDim }}>
              WBGT {plan.peakWbgt} / {plan.peakWbgtHour}:00
            </span>
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 13, color: T.textFaint }}>
            {VENUE.name} ／ {scenario.geo.name}
          </div>
          <div className="cw-mono" style={{ fontSize: 19, fontWeight: 600, color: T.text }}>
            {hour}:00
          </div>
        </div>
      </div>

      {/* ── 時間帯別予報（一日の形を最初に見せる） ───────── */}
      <HourlyStrip
        zones={zones}
        scenario={scenario}
        hour={hour}
        onHourChange={setHour}
        scopeLabel={scopeLabel}
      />

      <div className="cw-split" style={{ display: "grid", gridTemplateColumns: "312px minmax(0,1fr)", gap: 14 }}>
        {/* ── 左レール：条件と打ち手 ───────────────── */}
        <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <Card title="予報条件" note="全タブ連動">
            <Field label="会場の場所" value={scenario.geo.name}>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={placeQuery}
                  onChange={(e) => setPlaceQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyPlace()}
                  placeholder="東京 / 大阪 / 幕張 …"
                  aria-label="会場の場所"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "8px 11px",
                    borderRadius: 8,
                    border: `1px solid ${T.line}`,
                    background: T.raised,
                    color: T.text,
                    fontSize: 13,
                  }}
                />
                <button
                  onClick={applyPlace}
                  disabled={placeBusy || !placeQuery.trim()}
                  style={{
                    minHeight: 44,
                    padding: "8px 13px",
                    borderRadius: 8,
                    border: `1px solid ${T.line}`,
                    background: "transparent",
                    color: placeBusy ? T.textFaint : T.text,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: placeBusy ? "wait" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  設定
                </button>
              </div>
              {placeError && (
                // §5-2b: 暗色地用の #FCA5A5（白地1.69:1）→ T.danger（白地6.85:1）
                <div style={{ marginTop: 6, fontSize: 13, color: T.danger }}>{placeError}</div>
              )}
              <div className="cw-mono" style={{ marginTop: 6, fontSize: 13, color: T.textFaint }}>
                {scenario.geo.lat.toFixed(3)}°N {scenario.geo.lon.toFixed(3)}°E ／ 実況取得と太陽位置に反映
              </div>
            </Field>

            <button
              onClick={applyLive}
              disabled={liveBusy}
              style={{
                width: "100%",
                marginBottom: 13,
                minHeight: 44,
                padding: "10px 0",
                borderRadius: 9,
                border: `1px solid ${T.accent}`,
                background: "transparent",
                color: T.accent,
                fontWeight: 700,
                fontSize: 13,
                cursor: liveBusy ? "wait" : "pointer",
              }}
            >
              {liveBusy ? "実況を取得中…" : "1. 現在の状況に更新"}
            </button>
            {liveAt && liveAt !== "error" && (
              <div
                className="cw-mono"
                // §5-2b: 暗色地用の #22C55E（白地2.28:1）→ 既存の「一次確認済み」成功色 #0F6E56（白地6.20:1）を再利用。
                // テーマ切替に追従させるため sem.good 経由に統一
                style={{ marginTop: -8, marginBottom: 10, fontSize: 13, color: sem.good }}
              >
                LIVE {scenario.date.label} {liveAt} 時点の実況（Open-Meteo）を反映中
              </div>
            )}
            {liveAt === "error" && (
              <div style={{ marginTop: -8, marginBottom: 10, fontSize: 13, color: T.danger }}>
                実況を取得できませんでした（手入力の値のまま）
              </div>
            )}
            <Field label="天候">
              <div style={{ display: "flex", gap: 6 }}>
                {(["sunny", "cloudy", "rainy"] as Weather[]).map((w) => (
                  <button
                    key={w}
                    onClick={() => set("weather", w)}
                    aria-pressed={scenario.weather === w}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      padding: "8px 0",
                      borderRadius: 9,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: `1px solid ${scenario.weather === w ? T.accent : T.line}`,
                      background: scenario.weather === w ? T.accent : "transparent",
                      color: scenario.weather === w ? T.page : T.textDim,
                    }}
                  >
                    {WEATHER_GLYPH[w]} {WEATHER_LABEL[w]}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label="予想最高気温"
              value={`${scenario.temp}℃`}
              // §5-2b: 暗色地用の #EF4444（白地3.76:1・AA未達）→ T.danger（白地6.85:1）
              valueColor={scenario.temp >= 33 ? T.danger : T.text}
            >
              <input
                type="range"
                min={22}
                max={39}
                value={scenario.temp}
                onChange={(e) => set("temp", Number(e.target.value))}
                aria-label="予想最高気温"
              />
            </Field>
            <Field label="湿度" value={`${scenario.rhPct}%`}>
              <input
                type="range"
                min={30}
                max={95}
                step={5}
                value={scenario.rhPct}
                onChange={(e) => set("rhPct", Number(e.target.value))}
                aria-label="湿度"
              />
            </Field>
            <Field label="風速" value={`${scenario.windMs.toFixed(1)}m/s`}>
              <input
                type="range"
                min={0.2}
                max={5}
                step={0.1}
                value={scenario.windMs}
                onChange={(e) => set("windMs", Number(e.target.value))}
                aria-label="風速"
              />
            </Field>
            <Field label="チケット販売数" value={scenario.tickets.toLocaleString()}>
              <input
                type="range"
                min={5000}
                max={40000}
                step={1000}
                value={scenario.tickets}
                onChange={(e) => set("tickets", Number(e.target.value))}
                aria-label="チケット販売数"
              />
            </Field>
            <div
              className="cw-mono"
              style={{ fontSize: 13, color: T.textFaint, display: "flex", justifyContent: "space-between" }}
            >
              <span>開催日 {scenario.date.label}</span>
              <span>WBGT=湿球黒球の物理計算（湿度・風が効く）</span>
            </div>
          </Card>

          <Card title="推奨オペレーション" note="予報から自動生成">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Chip color="#38BDF8">給水 +{plan.water}</Chip>
              <Chip color="#22C55E">救護 +{plan.aid}</Chip>
              <Chip color="#FDE047">誘導 +{plan.guide}</Chip>
              {plan.mist && <Chip color="#38BDF8">ミスト稼働</Chip>}
              {plan.oneway && <Chip color="#FB7A1E">一方通行化</Chip>}
              {plan.entryControl && <Chip color="#E5254A">入退場制限を準備</Chip>}
              {plan.stationCoord && <Chip color="#C4B5FD">鉄道・警察と退場連携</Chip>}
              {plan.tents.total > 0 && <Chip color="#FDBA74">日よけテント {plan.tents.total}張</Chip>}
            </div>

            {plan.tents.total > 0 && (
              <div style={{ marginTop: 10, display: "grid", gap: 3 }}>
                {plan.tents.list.map((t) => (
                  <div
                    key={t.zoneId}
                    className="cw-mono"
                    style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textDim }}
                  >
                    <span>{t.zoneName}</span>
                    <span>
                      {t.need}張 / {fmtMin(t.from)}–{fmtMin(t.to)}
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 13, color: T.textFaint, lineHeight: 1.6 }}>
                  WBGT28以上なのに日陰6割未満の待機ゾーンに、3×6mテントの必要枚数を提案（馬場v4）
                </div>
              </div>
            )}

            <div
              style={{
                marginTop: 13,
                paddingTop: 12,
                borderTop: `1px solid ${T.hairline}`,
              }}
            >
              <div style={{ fontSize: 13, color: T.textDim }}>厚く置く → 賢く置く</div>
              <div className="cw-mono" style={{ marginTop: 4, fontSize: 15 }}>
                <span style={{ color: T.textFaint, textDecoration: "line-through" }}>
                  {plan.baselinePersonHours}
                </span>
                <span style={{ color: T.textFaint }}> → </span>
                <span style={{ color: T.text, fontWeight: 700 }}>{plan.optimizedPersonHours}人時</span>
                {/* §5-2b: 暗色地用の #22C55E（白地2.28:1）→ 既存の成功色 #0F6E56（白地6.20:1）を再利用。
                    削減率＝良好な結果なので sem.good 経由に統一（テーマ切替に追従） */}
                <span style={{ color: sem.good, fontWeight: 700 }}> −{plan.savedPercent}%</span>
              </div>
              <div style={{ fontSize: 13, color: T.textFaint, marginTop: 3, lineHeight: 1.6 }}>
                一律増員をやめ、ピーク時間帯と危険エリアに寄せた場合の1イベント試算
              </div>
            </div>

          </Card>
        </aside>

        {/* ── 会場図 ──────────────────────────────── */}
        <section style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: T.textDim,
                border: `1px solid ${T.line}`,
                borderRadius: 9,
                padding: "9px 13px",
              }}
            >
              会場内＋会場外
            </span>
            <Toggle
              options={[
                ["crowd", "混雑"],
                ["heat", "暑熱・日陰"],
              ]}
              value={layer}
              onChange={(v) => setLayer(v as MapLayer)}
            />
            <Legend layer={layer} />
            <a
              href={`/heatmap?temp=${scenario.temp}&rh=${scenario.rhPct}&wind=${scenario.windMs}&tickets=${scenario.tickets}&weather=${scenario.weather}&hour=${hour}&date=${scenario.date.y}-${scenario.date.mo}-${scenario.date.d}&lat=${scenario.geo.lat}&lon=${scenario.geo.lon}&place=${encodeURIComponent(scenario.geo.name)}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                padding: "0 14px",
                borderRadius: 9,
                border: `1px solid ${T.line}`,
                background: T.surface,
                color: T.textDim,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              全画面で見る ↗
            </a>
          </div>

          <VenueMap
            zones={zones}
            hour={hour}
            scenario={scenario}
            layer={layer}
            nowHour={clockHour}
            peakHour={peak.hour}
            /* 2026-08-14: `staff` を算出しながら渡していないデッドコードだった（:133のコメントは
               「地図にはポストコード付きマークとして出す」と書いてあるのに繋がっていなかった）。
               これが「計画モードの会場図に受付ポスト R-1〜R-8 が出ない」の真因。 */
            staff={staff}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Stat
              label="最混雑"
              value={now.maxDensityZone.name}
              sub={`${now.maxDensity} ${densityBand(now.maxDensity).label}`}
              color={densityBand(now.maxDensity).color}
            />
            <Stat
              label="最暑熱"
              value={now.maxWbgtZone.name}
              sub={`WBGT ${now.maxWbgt} ${wbgtBand(now.maxWbgt).label}`}
              color={wbgtBand(now.maxWbgt).color}
            />
            <Stat
              label="日陰カバー率"
              value={`${now.shadeRate}%`}
              sub={`${scopeLabel}ゾーン`}
              color="#7DD3FC"
            />
          </div>

          {/* ── AIアドバイザー ─────────────────────── */}
          <div
            style={{
              background: T.surface,
              border: `1px solid ${T.line}`,
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13, letterSpacing: 1.5, color: T.textFaint }}>
                  AI OPERATIONS ADVISOR — OrcaRouter
                </div>
                <div style={{ fontWeight: 600, fontSize: 15, marginTop: 3 }}>
                  この予報を、現場の言葉に翻訳する。
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    onClick={() => askOrca("directive")}
                    disabled={aiBusy}
                    style={{
                      minHeight: 44,
                      padding: "12px 22px",
                      borderRadius: 999,
                      border: "none",
                      background: aiBusy ? T.raised : T.accent,
                      color: aiBusy ? T.textDim : T.page,
                      fontWeight: 700,
                      fontSize: 15,
                      cursor: aiBusy ? "wait" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {aiBusy ? "起草中…" : "2. 現場に出すべき指示"}
                  </button>
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: T.textDim,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={easyStyle}
                    onChange={(e) => setEasyStyle(e.target.checked)}
                  />
                  やさしい日本語で出す
                </label>
              </div>
            </div>

            {advice && (
              <div
                style={{
                  marginTop: 13,
                  background: T.raised,
                  border: `1px solid ${T.line}`,
                  borderRadius: 10,
                  padding: "13px 15px",
                  fontSize: 13,
                  lineHeight: 1.85,
                  whiteSpace: "pre-wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 7 }}>
                  <SourceTag kind="ai" tone={name === "night" ? "ink" : "day"} />
                  {adviceLabel && (
                    <span className="cw-mono" style={{ fontSize: 13, color: T.textFaint }}>
                      {adviceLabel}
                      {easyStyle ? "・やさしい日本語" : ""}
                    </span>
                  )}
                </div>
                {advice}
              </div>
            )}

            {aiMeta && (
              <div
                className="cw-mono"
                style={{
                  marginTop: 9,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 7,
                  alignItems: "center",
                  fontSize: 13,
                  color: T.textFaint,
                }}
              >
                <span>処理したモデル</span>
                <Chip color="#C4B5FD">{aiMeta.servedModel}</Chip>
                {aiMeta.router && aiMeta.resolvedModel && (
                  <Chip color="#7DD3FC">ルーター解決 → {aiMeta.resolvedModel}</Chip>
                )}
                {aiMeta.fallbackLevel > 0 && (
                  <Chip color="#FB7A1E">第一候補が失敗 → {aiMeta.fallbackLevel}段目で応答</Chip>
                )}
                {aiMeta.usage && (
                  <Chip color="#93A3C0">
                    in {aiMeta.usage.prompt_tokens} / out {aiMeta.usage.completion_tokens} tok
                  </Chip>
                )}
                <Chip color="#93A3C0">{aiMeta.latencyMs}ms</Chip>
                {/* トークン=実測（usage）× 公表単価。lib/ai/pricing.ts が唯一の出所 */}
                <Chip color="#86EFAC">{formatYen(costYenForMeta(aiMeta))}</Chip>
              </div>
            )}

            {/* ── 多声ブリーフィング: 同じ予報を2系統に書き分け ── */}
            <div
              style={{
                marginTop: 13,
                paddingTop: 12,
                borderTop: `1px solid ${T.hairline}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: T.textDim, lineHeight: 1.7 }}>
                <b style={{ color: T.text }}>2系統ブリーフィング</b> — 同じ予報を「責任者（上位モデル）／スタッフ（軽量）」へ並列に書き分ける。
              </div>
              <button
                onClick={askBriefings}
                disabled={briefBusy}
                style={{
                  minHeight: 44,
                  padding: "9px 16px",
                  borderRadius: 999,
                  border: `1px solid ${T.line}`,
                  background: "transparent",
                  color: briefBusy ? T.textFaint : T.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: briefBusy ? "wait" : "pointer",
                }}
              >
                {briefBusy ? "2系統を並列生成中…" : "2系統に配信文を作る"}
              </button>
            </div>

            {briefs && (
              <div
                className="cw-split"
                style={{ marginTop: 11, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}
              >
                {(
                  [
                    ["responsible", "警備責任者向け", "#C4B5FD"],
                    ["staff", "現場スタッフ向け", "#7DD3FC"],
                  ] as const
                ).map(([key, label, color]) => {
                  const b = briefs[key];
                  return (
                    <div
                      key={key}
                      style={{
                        background: T.raised,
                        border: `1px solid ${T.line}`,
                        borderTop: `2px solid ${color}`,
                        borderRadius: 10,
                        padding: "11px 12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {/* §1-3 パターン3の既知例（責任者向け#C4B5FD=白地1.85:1／スタッフ向け#7DD3FC=白地1.67:1・
                            いずれも判読不能）。色は上のborderTopの帯で示し、文字は墨色にする */}
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{label}</span>
                        <SourceTag kind="ai" tone={name === "night" ? "ink" : "day"} />
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", flex: 1 }}>
                        {b?.text}
                      </div>
                      {b?.meta && (
                        <div className="cw-mono" style={{ fontSize: 13, color: T.textFaint }}>
                          {b.meta.servedModel} ／ {(b.meta.latencyMs / 1000).toFixed(1)}s
                          {b.meta.usage ? ` ／ out ${b.meta.usage.completion_tokens}tok` : ""}
                          {` ／ ${formatYen(costYenForMeta(b.meta))}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── What-if 自然言語シナリオ ─────────────── */}
          <div
            style={{
              background: T.surface,
              border: `1px solid ${T.line}`,
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 13, letterSpacing: 1.5, color: T.textFaint }}>
              WHAT-IF — 言葉でシナリオを動かす
            </div>
            <div style={{ fontSize: 13, color: T.textDim, marginTop: 5, lineHeight: 1.7 }}>
              「もし17時に雷雨が来たら？」— AIは条件変更に<b>翻訳するだけ</b>。数字は計算エンジンが出し直す。
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
              <input
                value={whatifQ}
                onChange={(e) => setWhatifQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && askWhatif()}
                placeholder="例: 気温が38度まで上がって無風になったら？"
                style={{
                  flex: 1,
                  padding: "10px 13px",
                  borderRadius: 9,
                  border: `1px solid ${T.line}`,
                  background: T.raised,
                  color: T.text,
                  fontSize: 13,
                }}
              />
              <button
                onClick={askWhatif}
                disabled={whatifBusy || !whatifQ.trim()}
                style={{
                  minHeight: 44,
                  padding: "10px 18px",
                  borderRadius: 9,
                  border: "none",
                  background: whatifBusy ? T.raised : T.accent,
                  color: whatifBusy ? T.textDim : T.page,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: whatifBusy ? "wait" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {whatifBusy ? "解釈中…" : "試す"}
              </button>
            </div>

            {whatifError && (
              <div style={{ marginTop: 9, fontSize: 13, color: T.danger }}>{whatifError}</div>
            )}

            {whatif && (
              <div style={{ marginTop: 11 }}>
                <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.7 }}>
                  解釈: {whatif.interpretation}
                </div>
                {whatif.feasible && whatifPlan && (
                  <div
                    style={{
                      marginTop: 9,
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 9,
                    }}
                  >
                    <DeltaStat
                      label="混雑ピーク"
                      before={plan.peakDensity}
                      after={whatifPlan.peakDensity}
                      unit=""
                      sub={`${whatifPlan.peakDensityHour}:00 ${whatifPlan.peakDensityZone.name}`}
                    />
                    <DeltaStat
                      label="暑熱ピーク WBGT"
                      before={plan.peakWbgt}
                      after={whatifPlan.peakWbgt}
                      unit=""
                      sub={wbgtBand(whatifPlan.peakWbgt).label}
                    />
                    <DeltaStat
                      label="日よけテント"
                      before={plan.tents.total}
                      after={whatifPlan.tents.total}
                      unit="張"
                      sub={whatifPlan.tents.total > 0 ? "待機ゾーンに提案" : "不要"}
                    />
                    <DeltaStat
                      label="誘導スタッフ"
                      before={plan.guide}
                      after={whatifPlan.guide}
                      unit="名増員"
                      sub={whatifPlan.entryControl ? "入退場制限も準備" : "通常運用"}
                    />
                  </div>
                )}
                {whatif.feasible && (
                  <button
                    onClick={() => {
                      setScenario(whatif.scenario);
                      setHour(Math.max(VENUE.open, Math.min(VENUE.close, whatif.hour)));
                      setLiveAt(null);
                      setWhatif(null);
                      setWhatifQ("");
                    }}
                    style={{
                      marginTop: 10,
                      minHeight: 44,
                      padding: "8px 15px",
                      borderRadius: 999,
                      border: `1px solid ${T.line}`,
                      background: "transparent",
                      color: T.text,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    この条件を画面全体に適用する
                  </button>
                )}
                <div className="cw-mono" style={{ marginTop: 8, fontSize: 13, color: T.textFaint }}>
                  解釈: {whatif.meta.servedModel} ／ {(whatif.meta.latencyMs / 1000).toFixed(1)}s ／{" "}
                  {formatYen(costYenForMeta(whatif.meta))} ／ 再計算: エンジン（LLM不使用・¥0）
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── 入場が混む時間帯（ゲート待ち行列予測） ── */}
      <EntryPeak tickets={scenario.tickets} tone={name === "night" ? "ink" : "day"} />

      {/* ── ゾーン別 危険度（どこが、いつ、危険になるか） ── */}
      <ZoneTimeline zones={zones} scenario={scenario} hour={hour} onHourChange={setHour} />

      {/* 危険の到来順（馬場氏要望 08-13: ZONE TIMELINEの下側に常設。レイヤーに依存しない） */}
      <div style={{ marginTop: 10 }}>
        <ArrivalList arrivals={arrivals} hour={hour} />
      </div>

      {/* 計画書は「計画書出力」タブへ独立（2026-08-13 画面構成再編）。同じScenarioを共有している */}
    </div>
  );
}

/** 分 → "HH:MM"（テント提案の時間帯表示用） */
const fmtMin = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** What-if 比較の1マス。現行→仮定の変化を矢印と色で示す */
function DeltaStat({
  label,
  before,
  after,
  unit,
  sub,
}: {
  label: string;
  before: number;
  after: number;
  unit: string;
  sub: string;
}) {
  const { T, sem } = useTheme();
  const worse = after > before;
  const same = after === before;
  // §5-2b: 暗色地用の #FB7A1E（白地2.26:1）／#22C55E（白地2.28:1）は判読不能。
  // #B45309（悪化・二次資料色の白地5.02:1）／#0F6E56（改善・成功色の白地6.20:1）を再利用。
  // テーマ切替に追従させるため sem.caution / sem.good 経由に統一
  const color = same ? T.textDim : worse ? sem.caution : sem.good;
  return (
    <div
      style={{
        background: T.raised,
        border: `1px solid ${T.line}`,
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 13, color: T.textFaint }}>{label}</div>
      <div className="cw-mono" style={{ marginTop: 4, fontSize: 15 }}>
        <span style={{ color: T.textDim }}>{before}</span>
        <span style={{ color: T.textFaint }}> → </span>
        <span style={{ color, fontWeight: 700 }}>
          {after}
          {unit}
        </span>
      </div>
      <div style={{ fontSize: 13, color: T.textFaint, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// ── 小物 ──────────────────────────────────────────────────────────

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  const { T } = useTheme();
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 12, padding: 15 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: 0.4 }}>{title}</h2>
        {note && <span style={{ fontSize: 13, color: T.textFaint }}>{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  valueColor,
  children,
}: {
  label: string;
  value?: string;
  valueColor?: string;
  children: React.ReactNode;
}) {
  const { T } = useTheme();
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 13, color: T.textDim }}>{label}</span>
        {value && (
          <span className="cw-mono" style={{ fontSize: 13, fontWeight: 600, color: valueColor ?? T.text }}>
            {value}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * カラーコード付きラベルチップ。§1-3 パターン2: 背景アルファを 1A(10%) → 26(15%) へ引き上げ、
 * 文字色は常に墨色（T.text）にする（渡ってくる生hexは暗色地向けのため、白地で軒並み4.5:1未満）。
 */
function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  const { T } = useTheme();
  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: T.text,
        background: `${color}26`,
        border: `1px solid ${color}66`,
        borderRadius: 999,
        padding: "4px 10px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  const { T } = useTheme();
  return (
    <div style={{ display: "flex", gap: 3, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 9, padding: 3 }}>
      {options.map(([k, l]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          aria-pressed={value === k}
          style={{
            minHeight: 44,
            padding: "6px 13px",
            borderRadius: 7,
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
            background: value === k ? T.raised : "transparent",
            color: value === k ? T.text : T.textDim,
            boxShadow: value === k ? `inset 0 0 0 1px ${T.line}` : "none",
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function Legend({ layer }: { layer: MapLayer }) {
  const bands =
    layer === "crowd"
      ? [densityBand(10), densityBand(35), densityBand(60), densityBand(90)]
      : [wbgtBand(23), wbgtBand(26), wbgtBand(29), wbgtBand(33)];
  const { T } = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexWrap: "wrap" }}>
      {bands.map((b) => (
        <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: T.textDim }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: b.color, display: "inline-block" }} />
          {b.label}
        </span>
      ))}
    </div>
  );
}

/**
 * 危険の到来順。「これから危なくなる場所」を時刻順に並べた表。
 * 地図が空間、この表が時間。2つで「いつ・どこが」が揃う。
 */
function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const { T } = useTheme();
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: "11px 13px" }}>
      <div style={{ fontSize: 13, color: T.textFaint }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3, color: T.text }}>{value}</div>
      {/* §5-2b: 呼び出し側は段階色／生hexを渡すため（白地で軒並み4.5:1未満）、
          文字は墨色にし色は左の小さなドットへ移す（§3-4の規約どおり） */}
      <div className="cw-mono" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, color: T.textDim, marginTop: 2 }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flex: "none" }} />
        {sub}
      </div>
    </div>
  );
}
