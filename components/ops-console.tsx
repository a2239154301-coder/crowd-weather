"use client";

import { useMemo, useState } from "react";
import type { Scenario, Weather } from "@/lib/forecast/types";
import { VENUE, zonesFor } from "@/lib/forecast/venue";
import { centroid, dayPlan, hourPeak } from "@/lib/forecast/model";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import VenueMap, { type MapLayer, type StaffMark } from "./venue-map";
import ForecastTimeline from "./forecast-timeline";
import SecurityPlan from "./security-plan";

const WEATHER_LABEL: Record<Weather, string> = { sunny: "晴", cloudy: "曇", rainy: "雨" };
const WEATHER_GLYPH: Record<Weather, string> = { sunny: "☀", cloudy: "☁", rainy: "☂" };

type AiMeta = {
  servedModel: string;
  requestedModel: string;
  fallbackLevel: number;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
};

export default function OpsConsole() {
  const [scenario, setScenario] = useState<Scenario>({ weather: "sunny", temp: 34, tickets: 24000 });
  const [hour, setHour] = useState(15);
  const [scope, setScope] = useState<"in" | "out">("in");
  const [layer, setLayer] = useState<MapLayer>("crowd");
  const [planOpen, setPlanOpen] = useState(false);

  const [advice, setAdvice] = useState("");
  const [aiMeta, setAiMeta] = useState<(AiMeta & { latencyMs: number }) | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const zones = useMemo(() => zonesFor(scope), [scope]);
  const plan = useMemo(() => dayPlan(scenario), [scenario]);
  const now = useMemo(() => hourPeak(zones, hour, scenario), [zones, hour, scenario]);

  const dayBand = densityBand(plan.peakDensity);
  const heatBand = wbgtBand(plan.peakWbgt);
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) =>
    setScenario((p) => ({ ...p, [k]: v }));

  const staff: StaffMark[] = useMemo(() => marksFor(plan), [plan]);

  async function askOrca() {
    setAiBusy(true);
    setAdvice("");
    setAiMeta(null);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venue: VENUE.name,
          hour,
          scope: scope === "in" ? "会場内" : "会場外",
          weather: WEATHER_LABEL[scenario.weather],
          temp: scenario.temp,
          tickets: scenario.tickets,
          current: {
            maxCrowd: now.maxDensity,
            maxCrowdZone: now.maxDensityZone.name,
            maxWBGT: now.maxWbgt,
            maxWBGTZone: now.maxWbgtZone.name,
            shadeRate: now.shadeRate,
          },
          dayPlan: {
            peakCrowd: plan.peakDensity,
            peakCrowdHour: plan.peakDensityHour,
            peakCrowdZone: plan.peakDensityZone.name,
            peakWBGT: plan.peakWbgt,
            peakWBGTHour: plan.peakWbgtHour,
          },
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
          <div style={{ fontSize: 11, color: INK.textFaint }}>{VENUE.name}</div>
          <div className="cw-mono" style={{ fontSize: 20, fontWeight: 600, color: INK.text }}>
            {hour}:00
          </div>
        </div>
      </div>

      <div className="cw-split" style={{ display: "grid", gridTemplateColumns: "312px minmax(0,1fr)", gap: 14 }}>
        {/* ── 左レール：条件と打ち手 ───────────────── */}
        <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <Card title="予報条件" note="この3つで一日が決まる">
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
            </div>

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

            <button
              onClick={() => setPlanOpen((v) => !v)}
              style={{
                marginTop: 13,
                width: "100%",
                padding: "12px 0",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 13.5,
                background: planOpen ? "transparent" : INK.text,
                color: planOpen ? INK.text : INK.page,
                boxShadow: planOpen ? `inset 0 0 0 1px ${INK.line}` : "none",
              }}
            >
              {planOpen ? "計画書を閉じる" : "雑踏警備計画書を出力"}
            </button>
          </Card>
        </aside>

        {/* ── 会場図 ──────────────────────────────── */}
        <section style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Toggle
              options={[
                ["in", "会場内"],
                ["out", "会場外"],
              ]}
              value={scope}
              onChange={(v) => setScope(v as "in" | "out")}
            />
            <Toggle
              options={[
                ["crowd", "混雑"],
                ["heat", "暑熱・日陰"],
              ]}
              value={layer}
              onChange={(v) => setLayer(v as MapLayer)}
            />
            <Legend layer={layer} />
          </div>

          <VenueMap zones={zones} hour={hour} scenario={scenario} layer={layer} />

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
              sub={scope === "in" ? "会場内ゾーン" : "会場外ゾーン"}
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
                  混雑・WBGT・日陰率・来場規模を渡し、次の打ち手を4項目で出す。
                  予報の計算そのものにLLMは使っていない。
                </div>
              </div>
              <button
                onClick={askOrca}
                disabled={aiBusy}
                style={{
                  padding: "10px 18px",
                  borderRadius: 999,
                  border: `1px solid ${INK.accent}`,
                  background: aiBusy ? "transparent" : INK.accent,
                  color: aiBusy ? INK.accent : INK.page,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: aiBusy ? "wait" : "pointer",
                }}
              >
                {aiBusy ? "分析中…" : "運営判断を聞く"}
              </button>
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
                {aiMeta.fallbackLevel > 0 && (
                  <Chip color="#FB7A1E">第一候補が失敗 → {aiMeta.fallbackLevel}段目で応答</Chip>
                )}
                {aiMeta.usage && (
                  <Chip color="#93A3C0">
                    in {aiMeta.usage.prompt_tokens} / out {aiMeta.usage.completion_tokens} tok
                  </Chip>
                )}
                <Chip color="#93A3C0">{aiMeta.latencyMs}ms</Chip>
              </div>
            )}
          </div>
        </section>
      </div>

      <ForecastTimeline zones={zones} scenario={scenario} hour={hour} onHourChange={setHour} />

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
      : [wbgtBand(23), wbgtBand(26), wbgtBand(29), wbgtBand(33)];
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
