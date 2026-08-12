"use client";

import { useMemo, useState } from "react";
import type { Scenario, Weather } from "@/lib/forecast/types";
import { VENUE, zonesFor, DEFAULT_SCENARIO, HOURS } from "@/lib/forecast/venue";
import { centroid, dayPlan, hourPeak } from "@/lib/forecast/model";
import { fetchLiveWeather, geocode } from "@/lib/weather/open-meteo";
import HourlyStrip from "./hourly-strip";
import ZoneTimeline from "./zone-timeline";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import { TIME_BANDS, arrivalOrder, timeBand, zoneRisks, type ZoneRisk } from "@/lib/forecast/risk";
import { costYenForMeta, formatYen } from "@/lib/ai/pricing";
import VenueMap, { type MapLayer, type StaffMark } from "./venue-map";
import SecurityPlan from "./security-plan";

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
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [hour, setHour] = useState(15);
  const [scope, setScope] = useState<"in" | "out">("in");
  const [layer, setLayer] = useState<MapLayer>("risk");
  const [planOpen, setPlanOpen] = useState(false);

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

  // リスク予報は会場内外をまとめて出す。危険は終演時に
  // 退場動線 → 駅前広場 → 改札 → ホーム と境界をまたいで移るので、分けると話が切れる。
  // 画面・統計・AIへ渡す予報は、すべてこの zones に揃える
  const zones = useMemo(
    () => (layer === "risk" ? VENUE.zones : zonesFor(scope)),
    [layer, scope]
  );
  const scopeLabel = layer === "risk" ? "会場内＋会場外" : scope === "in" ? "会場内" : "会場外";

  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const now = useMemo(() => hourPeak(zones, hour, scenario), [zones, hour, scenario]);

  const risks = useMemo(
    () => (layer === "risk" ? zoneRisks(zones, hour, scenario) : null),
    [layer, zones, hour, scenario]
  );
  const arrivals = useMemo(() => (risks ? arrivalOrder(risks) : []), [risks]);

  const dayBand = densityBand(plan.peakDensity);
  const heatBand = wbgtBand(plan.peakWbgt);
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) =>
    setScenario((p) => ({ ...p, [k]: v }));

  const staff: StaffMark[] = useMemo(() => marksFor(plan), [plan]);

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

  // ── 多声ブリーフィング（同じ予報を3系統に書き分け・並列生成） ──
  type Brief = { text: string; meta: (AiMeta & { latencyMs: number }) | null; error?: boolean };
  const [briefs, setBriefs] = useState<Record<string, Brief> | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);

  async function askBriefings() {
    setBriefBusy(true);
    setBriefs(null);
    const audiences = [
      ["responsible", "警備責任者"],
      ["staff", "現場スタッフ"],
      ["visitor", "来場者"],
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
          background: INK.surface,
          border: `1px solid ${INK.line}`,
          borderLeft: `3px solid ${dayBand.color}`,
          borderRadius: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: INK.textFaint, letterSpacing: 1 }}>本日の最大警戒</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: dayBand.color }}>
              混雑 {dayBand.label}
            </span>
            <span className="cw-mono" style={{ fontSize: 13, color: INK.textDim }}>
              {plan.peakDensity} / {plan.peakDensityHour}:00 {plan.peakDensityZone.name}
            </span>
          </div>
        </div>
        <div style={{ width: 1, height: 32, background: INK.line }} />
        <div>
          <div style={{ fontSize: 11, color: INK.textFaint, letterSpacing: 1 }}>暑熱</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: heatBand.color }}>{heatBand.label}</span>
            <span className="cw-mono" style={{ fontSize: 13, color: INK.textDim }}>
              WBGT {plan.peakWbgt} / {plan.peakWbgtHour}:00
            </span>
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 11, color: INK.textFaint }}>
            {VENUE.name} ／ {scenario.geo.name}
          </div>
          <div className="cw-mono" style={{ fontSize: 20, fontWeight: 600, color: INK.text }}>
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
                    border: `1px solid ${INK.line}`,
                    background: INK.raised,
                    color: INK.text,
                    fontSize: 12.5,
                  }}
                />
                <button
                  onClick={applyPlace}
                  disabled={placeBusy || !placeQuery.trim()}
                  style={{
                    padding: "8px 13px",
                    borderRadius: 8,
                    border: `1px solid ${INK.line}`,
                    background: "transparent",
                    color: placeBusy ? INK.textFaint : INK.text,
                    fontWeight: 600,
                    fontSize: 12.5,
                    cursor: placeBusy ? "wait" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  設定
                </button>
              </div>
              {placeError && (
                <div style={{ marginTop: 6, fontSize: 10.5, color: "#FCA5A5" }}>{placeError}</div>
              )}
              <div className="cw-mono" style={{ marginTop: 6, fontSize: 10, color: INK.textFaint }}>
                {scenario.geo.lat.toFixed(3)}°N {scenario.geo.lon.toFixed(3)}°E ／ 実況取得と太陽位置に反映
              </div>
            </Field>

            <button
              onClick={applyLive}
              disabled={liveBusy}
              style={{
                width: "100%",
                marginBottom: 13,
                padding: "10px 0",
                borderRadius: 9,
                border: `1px solid ${INK.accent}`,
                background: "transparent",
                color: INK.accent,
                fontWeight: 700,
                fontSize: 12.5,
                cursor: liveBusy ? "wait" : "pointer",
              }}
            >
              {liveBusy ? "実況を取得中…" : "1. 現在の状況を反映"}
            </button>
            {liveAt && liveAt !== "error" && (
              <div
                className="cw-mono"
                style={{ marginTop: -8, marginBottom: 10, fontSize: 10.5, color: "#22C55E" }}
              >
                LIVE {scenario.date.label} {liveAt} 時点の実況（Open-Meteo）を反映中
              </div>
            )}
            {liveAt === "error" && (
              <div style={{ marginTop: -8, marginBottom: 10, fontSize: 10.5, color: "#FCA5A5" }}>
                実況を取得できませんでした（手入力の値のまま）
              </div>
            )}
            <div
              style={{
                marginBottom: 13,
                fontSize: 10.5,
                color: INK.textFaint,
                lineHeight: 1.6,
              }}
            >
              → 次は右の「2. やるべきことを出力」へ
            </div>
            <Field label="天候">
              <div style={{ display: "flex", gap: 6 }}>
                {(["sunny", "cloudy", "rainy"] as Weather[]).map((w) => (
                  <button
                    key={w}
                    onClick={() => set("weather", w)}
                    aria-pressed={scenario.weather === w}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: 9,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: `1px solid ${scenario.weather === w ? INK.accent : INK.line}`,
                      background: scenario.weather === w ? INK.accent : "transparent",
                      color: scenario.weather === w ? INK.page : INK.textDim,
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
              valueColor={scenario.temp >= 33 ? "#EF4444" : INK.text}
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
              style={{ fontSize: 10.5, color: INK.textFaint, display: "flex", justifyContent: "space-between" }}
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
                    style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: INK.textDim }}
                  >
                    <span>{t.zoneName}</span>
                    <span>
                      {t.need}張 / {fmtMin(t.from)}–{fmtMin(t.to)}
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 10, color: INK.textFaint, lineHeight: 1.6 }}>
                  WBGT28以上なのに日陰6割未満の待機ゾーンに、3×6mテントの必要枚数を提案（馬場v4）
                </div>
              </div>
            )}

            <div
              style={{
                marginTop: 13,
                paddingTop: 12,
                borderTop: `1px solid ${INK.hairline}`,
              }}
            >
              <div style={{ fontSize: 11.5, color: INK.textDim }}>厚く置く → 賢く置く</div>
              <div className="cw-mono" style={{ marginTop: 4, fontSize: 15 }}>
                <span style={{ color: INK.textFaint, textDecoration: "line-through" }}>
                  {plan.baselinePersonHours}
                </span>
                <span style={{ color: INK.textFaint }}> → </span>
                <span style={{ color: INK.text, fontWeight: 700 }}>{plan.optimizedPersonHours}人時</span>
                <span style={{ color: "#22C55E", fontWeight: 700 }}> −{plan.savedPercent}%</span>
              </div>
              <div style={{ fontSize: 10.5, color: INK.textFaint, marginTop: 3, lineHeight: 1.6 }}>
                一律増員をやめ、ピーク時間帯と危険エリアに寄せた場合の1イベント試算
              </div>
            </div>

          </Card>
        </aside>

        {/* ── 会場図 ──────────────────────────────── */}
        <section style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {layer === "risk" ? (
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: INK.textDim,
                  border: `1px solid ${INK.line}`,
                  borderRadius: 9,
                  padding: "9px 13px",
                }}
              >
                会場内＋会場外
              </span>
            ) : (
              <Toggle
                options={[
                  ["in", "会場内"],
                  ["out", "会場外"],
                ]}
                value={scope}
                onChange={(v) => setScope(v as "in" | "out")}
              />
            )}
            <Toggle
              options={[
                ["risk", "リスク予報"],
                ["crowd", "混雑"],
                ["heat", "暑熱・日陰"],
              ]}
              value={layer}
              onChange={(v) => setLayer(v as MapLayer)}
            />
            <Legend layer={layer} />
            <a
              href="/heatmap"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                padding: "0 14px",
                borderRadius: 9,
                border: `1px solid ${INK.line}`,
                background: INK.surface,
                color: INK.textDim,
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              全画面で見る ↗
            </a>
          </div>

          <VenueMap zones={zones} hour={hour} scenario={scenario} layer={layer} />

          {layer === "risk" && (
            <>
              <p
                style={{
                  margin: 0,
                  fontSize: 12.5,
                  lineHeight: 1.8,
                  color: INK.textDim,
                  background: INK.raised,
                  border: `1px solid ${INK.line}`,
                  borderRadius: 10,
                  padding: "11px 13px",
                }}
              >
                色は<b style={{ color: INK.text }}>いまの値ではなく、危険帯に入るまでの残り時間</b>。
                判定は混雑が主で、WBGTが31℃以上のとき段を1つ上げる。
                既存サービスが出せるのは「いま混んでいる場所」まで —
                ここで出しているのは<b style={{ color: INK.text }}>これから危なくなる場所</b>。
              </p>
              <ArrivalList arrivals={arrivals} hour={hour} />
            </>
          )}

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

          {scope === "out" && (
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.8,
                color: INK.textDim,
                background: INK.raised,
                border: `1px dashed ${INK.line}`,
                borderRadius: 10,
                padding: "11px 13px",
              }}
            >
              事故の多くは会場の中ではなく、駅の連絡通路や帰り道で起きる。開場前は駅→ゲートの流入、
              終演後は路地とホームへの逆流が詰まりの主因。
              {plan.outsideDanger
                ? "本シナリオでは商店街の路地が危険密度に達するため、鉄道事業者・警察との退場連携を推奨。"
                : "本シナリオでは許容範囲。通常巡回でよい。"}
            </p>
          )}

          {/* ── AIアドバイザー ─────────────────────── */}
          <div
            style={{
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 11, letterSpacing: 1.5, color: INK.textFaint }}>
                  AI OPERATIONS ADVISOR — OrcaRouter
                </div>
                <div style={{ fontWeight: 600, fontSize: 15, marginTop: 3 }}>
                  この予報を、現場の言葉に翻訳する。
                </div>
                <div style={{ fontSize: 12, color: INK.textDim, marginTop: 5, lineHeight: 1.7 }}>
                  <b style={{ color: INK.text }}>2. やるべきことを出力</b> =
                  「〇時間後に〇〇のリスクが上がる → いま出す指示」の指示書。
                  <b style={{ color: INK.text }}>運営判断を聞く</b> = 打ち手を4項目で。
                  予報の計算そのものにLLMは使っていない。
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    onClick={() => askOrca("directive")}
                    disabled={aiBusy}
                    style={{
                      padding: "12px 22px",
                      borderRadius: 999,
                      border: "none",
                      background: aiBusy ? INK.raised : INK.accent,
                      color: aiBusy ? INK.textDim : INK.page,
                      fontWeight: 700,
                      fontSize: 13.5,
                      cursor: aiBusy ? "wait" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {aiBusy ? "起草中…" : "2. やるべきことを出力"}
                  </button>
                  <button
                    onClick={() => askOrca("advice")}
                    disabled={aiBusy}
                    style={{
                      padding: "12px 18px",
                      borderRadius: 999,
                      border: `1px solid ${INK.line}`,
                      background: "transparent",
                      color: aiBusy ? INK.textFaint : INK.textDim,
                      fontWeight: 600,
                      fontSize: 12.5,
                      cursor: aiBusy ? "wait" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    運営判断を聞く
                  </button>
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11.5,
                    color: INK.textDim,
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
                  background: INK.raised,
                  border: `1px solid ${INK.line}`,
                  borderRadius: 10,
                  padding: "13px 15px",
                  fontSize: 13,
                  lineHeight: 1.85,
                  whiteSpace: "pre-wrap",
                }}
              >
                {adviceLabel && (
                  <div
                    className="cw-mono"
                    style={{ fontSize: 10.5, color: INK.textFaint, marginBottom: 7 }}
                  >
                    {adviceLabel}
                    {easyStyle ? "・やさしい日本語" : ""}
                  </div>
                )}
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
                  fontSize: 10.5,
                  color: INK.textFaint,
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

            {/* ── 多声ブリーフィング: 同じ予報を3系統に書き分け ── */}
            <div
              style={{
                marginTop: 13,
                paddingTop: 12,
                borderTop: `1px solid ${INK.hairline}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: INK.textDim, lineHeight: 1.7 }}>
                <b style={{ color: INK.text }}>3系統ブリーフィング</b> — 同じ予報を
                「責任者（上位モデル）／スタッフ（軽量）／来場者（軽量・やさしい日本語）」へ
                並列に書き分ける。適材適所のルーティングが一目で分かるデモ。
              </div>
              <button
                onClick={askBriefings}
                disabled={briefBusy}
                style={{
                  padding: "9px 16px",
                  borderRadius: 999,
                  border: `1px solid ${INK.line}`,
                  background: "transparent",
                  color: briefBusy ? INK.textFaint : INK.text,
                  fontWeight: 700,
                  fontSize: 12.5,
                  cursor: briefBusy ? "wait" : "pointer",
                }}
              >
                {briefBusy ? "3系統を並列生成中…" : "3系統に配信文を作る"}
              </button>
            </div>

            {briefs && (
              <div
                className="cw-split"
                style={{ marginTop: 11, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}
              >
                {(
                  [
                    ["responsible", "警備責任者向け", "#C4B5FD"],
                    ["staff", "現場スタッフ向け", "#7DD3FC"],
                    ["visitor", "来場者向け", "#86EFAC"],
                  ] as const
                ).map(([key, label, color]) => {
                  const b = briefs[key];
                  return (
                    <div
                      key={key}
                      style={{
                        background: INK.raised,
                        border: `1px solid ${INK.line}`,
                        borderTop: `2px solid ${color}`,
                        borderRadius: 10,
                        padding: "11px 12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color }}>{label}</div>
                      <div style={{ fontSize: 12, lineHeight: 1.8, whiteSpace: "pre-wrap", flex: 1 }}>
                        {b?.text}
                      </div>
                      {b?.meta && (
                        <div className="cw-mono" style={{ fontSize: 9.5, color: INK.textFaint }}>
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
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.5, color: INK.textFaint }}>
              WHAT-IF — 言葉でシナリオを動かす
            </div>
            <div style={{ fontSize: 12, color: INK.textDim, marginTop: 5, lineHeight: 1.7 }}>
              「もし17時に雷雨が来たら？」— AIは質問を条件変更に<b>翻訳するだけ</b>。
              数字はすべて計算エンジンが出し直す（LLMに予測はさせない）。
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
                  border: `1px solid ${INK.line}`,
                  background: INK.raised,
                  color: INK.text,
                  fontSize: 13,
                }}
              />
              <button
                onClick={askWhatif}
                disabled={whatifBusy || !whatifQ.trim()}
                style={{
                  padding: "10px 18px",
                  borderRadius: 9,
                  border: "none",
                  background: whatifBusy ? INK.raised : INK.accent,
                  color: whatifBusy ? INK.textDim : INK.page,
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
              <div style={{ marginTop: 9, fontSize: 12, color: "#FCA5A5" }}>{whatifError}</div>
            )}

            {whatif && (
              <div style={{ marginTop: 11 }}>
                <div style={{ fontSize: 12, color: INK.textDim, lineHeight: 1.7 }}>
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
                      padding: "8px 15px",
                      borderRadius: 999,
                      border: `1px solid ${INK.line}`,
                      background: "transparent",
                      color: INK.text,
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    この条件を画面全体に適用する
                  </button>
                )}
                <div className="cw-mono" style={{ marginTop: 8, fontSize: 9.5, color: INK.textFaint }}>
                  解釈: {whatif.meta.servedModel} ／ {(whatif.meta.latencyMs / 1000).toFixed(1)}s ／{" "}
                  {formatYen(costYenForMeta(whatif.meta))} ／ 再計算: エンジン（LLM不使用・¥0）
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── ゾーン別 危険度（どこが、いつ、危険になるか） ── */}
      <ZoneTimeline zones={zones} scenario={scenario} hour={hour} onHourChange={setHour} />

      {/* ── 計画書の出力。ボタンは出力される場所の直上に置く ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          background: INK.surface,
          border: `1px solid ${INK.line}`,
          borderRadius: 14,
          padding: "14px 16px",
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            この予報を、そのまま提出できる文書にする。
          </div>
          <div style={{ fontSize: 12, color: INK.textDim, marginTop: 4, lineHeight: 1.7 }}>
            雑踏警備計画書＋配置図＋暑熱・日陰図を1枚に。総括はAIが起草し、印刷/PDF保存で手元に残る。
          </div>
        </div>
        <button
          onClick={() => setPlanOpen((v) => !v)}
          style={{
            padding: "13px 26px",
            borderRadius: 10,
            border: "none",
            cursor: "pointer",
            fontWeight: 700,
            fontSize: 14,
            background: planOpen ? "transparent" : INK.text,
            color: planOpen ? INK.text : INK.page,
            boxShadow: planOpen ? `inset 0 0 0 1px ${INK.line}` : "none",
          }}
        >
          {planOpen ? "計画書を閉じる" : "雑踏警備計画書を出力 ↓"}
        </button>
      </div>

      {planOpen && <SecurityPlan scenario={scenario} plan={plan} staff={staff} />}
    </div>
  );
}

/** 給水・誘導・救護を、その時間帯に最も必要なゾーンへ置く */
function marksFor(plan: ReturnType<typeof dayPlan>): StaffMark[] {
  const inside = zonesFor("in");
  const marks: StaffMark[] = [];
  const put = (zoneId: string, role: StaffMark["role"], label: string, n: number) => {
    const z = inside.find((v) => v.id === zoneId);
    if (!z) return;
    const c = z.label ?? centroid(z.shape);
    for (let i = 0; i < n; i++) {
      marks.push({ at: { x: c.x + (i - (n - 1) / 2) * 34, y: c.y + 26 }, role, label });
    }
  };
  put("shop", "water", "給水", Math.min(2, plan.water));
  if (plan.water > 2) put("wc", "water", "給水", 1);
  put("main", "guide", "誘導", Math.min(3, plan.guide));
  if (plan.guide > 3) put("exit", "guide", "誘導", Math.min(2, plan.guide - 3));
  put("aid", "aid", "救護", Math.min(2, plan.aid));
  return marks;
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
  const worse = after > before;
  const same = after === before;
  const color = same ? INK.textDim : worse ? "#FB7A1E" : "#22C55E";
  return (
    <div
      style={{
        background: INK.raised,
        border: `1px solid ${INK.line}`,
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 10.5, color: INK.textFaint }}>{label}</div>
      <div className="cw-mono" style={{ marginTop: 4, fontSize: 14 }}>
        <span style={{ color: INK.textDim }}>{before}</span>
        <span style={{ color: INK.textFaint }}> → </span>
        <span style={{ color, fontWeight: 700 }}>
          {after}
          {unit}
        </span>
      </div>
      <div style={{ fontSize: 10, color: INK.textFaint, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// ── 小物 ──────────────────────────────────────────────────────────

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 12, padding: 15 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, letterSpacing: 0.4 }}>{title}</h2>
        {note && <span style={{ fontSize: 10.5, color: INK.textFaint }}>{note}</span>}
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
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 12, color: INK.textDim }}>{label}</span>
        {value && (
          <span className="cw-mono" style={{ fontSize: 13, fontWeight: 600, color: valueColor ?? INK.text }}>
            {value}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        color,
        background: `${color}1A`,
        border: `1px solid ${color}55`,
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
  return (
    <div style={{ display: "flex", gap: 3, background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 9, padding: 3 }}>
      {options.map(([k, l]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          aria-pressed={value === k}
          style={{
            padding: "6px 13px",
            borderRadius: 7,
            border: "none",
            cursor: "pointer",
            fontSize: 12.5,
            fontWeight: 600,
            background: value === k ? INK.raised : "transparent",
            color: value === k ? INK.text : INK.textDim,
            boxShadow: value === k ? `inset 0 0 0 1px ${INK.line}` : "none",
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
      : layer === "heat"
        ? [wbgtBand(23), wbgtBand(26), wbgtBand(29), wbgtBand(33)]
        : [...TIME_BANDS].reverse();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexWrap: "wrap" }}>
      {bands.map((b) => (
        <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: INK.textDim }}>
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
function ArrivalList({ arrivals, hour }: { arrivals: ZoneRisk[]; hour: number }) {
  if (arrivals.length === 0) {
    return (
      <div
        style={{
          background: INK.surface,
          border: `1px solid ${INK.line}`,
          borderRadius: 12,
          padding: "14px 16px",
          fontSize: 13,
          color: INK.textDim,
        }}
      >
        {hour}:00 以降、終演まで危険帯に達するゾーンはありません。
      </div>
    );
  }
  return (
    <div style={{ background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 12, padding: "13px 16px" }}>
      <div style={{ fontSize: 11, letterSpacing: 1, color: INK.textFaint, marginBottom: 4 }}>
        危険の到来順（{hour}:00 以降）
      </div>
      {arrivals.map((r) => {
        const band = timeBand(r.hoursToDanger);
        const now = r.hoursToDanger === 0;
        return (
          <div
            key={r.zone.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              minHeight: 44,
              borderBottom: `1px solid ${INK.hairline}`,
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 3, background: band.color, flex: "none" }} />
            <span className="cw-mono" style={{ width: 54, fontSize: 13.5, color: now ? band.color : INK.text, fontWeight: 600 }}>
              {now ? "いま" : `${r.dangerHour}:00`}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600 }}>{r.zone.name}</span>
            <span style={{ fontSize: 13, color: INK.textDim }}>{r.dangerCause ?? "—"}</span>
            {/* 危険になる「その時刻」の予報値。いまの値ではない */}
            <span className="cw-mono" style={{ width: 118, textAlign: "right", fontSize: 13, color: INK.textDim }}>
              混{r.dangerDensity} / WBGT{r.dangerWbgt}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div style={{ background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 11, padding: "11px 13px" }}>
      <div style={{ fontSize: 11, color: INK.textFaint }}>{label}</div>
      <div style={{ fontSize: 14.5, fontWeight: 700, marginTop: 3, color: INK.text }}>{value}</div>
      <div className="cw-mono" style={{ fontSize: 11.5, color, marginTop: 2 }}>
        {sub}
      </div>
    </div>
  );
}
