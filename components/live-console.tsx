"use client";

import { useEffect, useMemo, useState } from "react";
import type { Scenario, Weather } from "@/lib/forecast/types";
import { useScenario } from "@/lib/ui/scenario-context";
import { DAY } from "@/lib/ui/day-theme";
import { DEFAULT_SCENARIO, HOURS, VENUE } from "@/lib/forecast/venue";
import { dayPlan, hourPeak } from "@/lib/forecast/model";
import { fetchLiveWeather } from "@/lib/weather/open-meteo";
import {
  arrivalOrder,
  explainDanger,
  riskCause,
  timeBand,
  zoneDayCurve,
  zoneRisks,
  type CurvePoint,
} from "@/lib/forecast/risk";
import type { Zone } from "@/lib/forecast/types";
import { costYenForMeta, formatYen } from "@/lib/ai/pricing";
import { evidenceLabel } from "@/lib/forecast/evidence";

/**
 * 当日モード（LIVE）— 1画面・1判断。
 *
 * 予報プロダクトの本番は当日の炎天下の現場であって、事務所のPCではない。
 * 準備モードは4画面分のスクロールがあるが、現場責任者が知りたいのは
 * 「いまどこが一番危ないか」と「何をするか」の2つだけなので、
 * 会場図・タイムライン・What-if はここには置かない（見たければ準備モードへ）。
 *
 * 屋外で読めることを最優先に、**この画面だけ明色**にしてある。
 * 直射日光下では暗色画面が最も読めない。
 * 全画面のライトモード化はチップのトークン設計をやり直してからなので、
 * ここは自前のトークンで閉じている（`INK` には手を触れない）。
 *
 * 段階色は `DENSITY_BANDS` 由来のものを**塗り・点・帯にだけ**使い、
 * 文字は必ず地の墨色で書く。明色地では黄・橙の上の文字が読めなくなるため。
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const WEATHER_LABEL: Record<Weather, string> = { sunny: "晴", cloudy: "曇", rainy: "雨" };

export default function LiveConsole() {
  // 予報条件は計画モードと共有（計画で作った条件が当日のベースになる）
  const { scenario, setScenario } = useScenario();
  const [hour, setHour] = useState(15);
  // 実時刻は描画後に入れる（SSRとクライアントで値が食い違うのを避ける）
  const [clock, setClock] = useState<string | null>(null);
  const [liveAt, setLiveAt] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);

  useEffect(() => {
    const d = new Date();
    setClock(`${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`);
    setHour(clamp(d.getHours(), VENUE.open, VENUE.close));
  }, []);

  async function applyLive() {
    if (liveBusy) return;
    setLiveBusy(true);
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
      setHour(clamp(Math.round(live.minutes / 60), VENUE.open, VENUE.close));
      setLiveAt(live.timeLabel);
    } catch {
      setLiveAt("error");
    } finally {
      setLiveBusy(false);
    }
  }

  const risks = useMemo(() => zoneRisks(VENUE.zones, hour, scenario), [hour, scenario]);
  const peak = useMemo(() => hourPeak(VENUE.zones, hour, scenario), [hour, scenario]);
  const plan = useMemo(() => dayPlan(scenario), [scenario]);

  /** いちばん危ないゾーン。段が同じなら混雑指数の高いほう */
  const top = useMemo(
    () =>
      [...risks].sort((a, b) => b.severity - a.severity || b.density - a.density)[0] ?? null,
    [risks]
  );
  const upcoming = useMemo(
    () => arrivalOrder(risks).filter((r) => (r.hoursToDanger ?? 0) > 0),
    [risks]
  );
  const dangerNow = risks.filter((r) => r.severity === 3);

  // ── 指示書（既存の /api/advice をそのまま使う。新しいAPIは作らない） ──
  const [directive, setDirective] = useState("");
  const [directiveMeta, setDirectiveMeta] = useState<{
    servedModel: string;
    resolvedModel: string | null;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
    latencyMs: number;
  } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  async function askDirective() {
    setAiBusy(true);
    setDirective("");
    setDirectiveMeta(null);
    const t0 = Date.now();
    try {
      const outlook = HOURS.filter((h) => h > hour && h <= hour + 3).map((h) => {
        const p = hourPeak(VENUE.zones, h, scenario);
        return {
          hour: h,
          maxCrowd: p.maxDensity,
          maxCrowdZone: p.maxDensityZone.name,
          maxWBGT: p.maxWbgt,
          maxWBGTZone: p.maxWbgtZone.name,
        };
      });
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "directive",
          style: "standard",
          forecast: {
            venue: VENUE.name,
            hour,
            scope: "会場内＋会場外",
            // 天候と一日の要約は準備モードと同じものを渡す（雨天か晴天かで指示が変わる）
            weather: WEATHER_LABEL[scenario.weather],
            temp: scenario.temp,
            humidity: scenario.rhPct,
            windMs: scenario.windMs,
            tickets: scenario.tickets,
            current: {
              maxCrowd: peak.maxDensity,
              maxCrowdZone: peak.maxDensityZone.name,
              maxWBGT: peak.maxWbgt,
              maxWBGTZone: peak.maxWbgtZone.name,
              shadeRate: peak.shadeRate,
            },
            // 当日モードの主張そのもの: いま危険なゾーンと、この先危険になるゾーン
            dangerNow: dangerNow.map((r) => ({
              zone: r.zone.name,
              crowd: r.density,
              wbgt: r.wbgt,
              cause: r.cause,
            })),
            upcoming: upcoming.slice(0, 4).map((r) => ({
              hour: r.dangerHour,
              zone: r.zone.name,
              cause: r.dangerCause,
            })),
            outlook,
            dayPlan: {
              peakCrowd: plan.peakDensity,
              peakCrowdHour: plan.peakDensityHour,
              peakCrowdZone: plan.peakDensityZone.name,
              peakWBGT: plan.peakWbgt,
              peakWBGTHour: plan.peakWbgtHour,
              tents: plan.tents,
            },
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      setDirective(data.text || "指示を取得できませんでした。");
      if (data.meta) setDirectiveMeta({ ...data.meta, latencyMs: Date.now() - t0 });
    } catch {
      setDirective(
        "指示を取得できませんでした。通信状況と ORCAROUTER_API_KEY を確認してください。"
      );
    } finally {
      setAiBusy(false);
    }
  }

  const topBand = top ? timeBand(top.hoursToDanger) : null;
  const next = upcoming[0] ?? null;

  return (
    <div
      style={{
        background: DAY.page,
        color: DAY.text,
        borderRadius: 16,
        border: `1px solid ${DAY.line}`,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      {/* ① いつ・どこ */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            background: "#E5254A",
            color: "#FFFFFF",
            borderRadius: 999,
            padding: "7px 14px",
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 999, background: "#FFFFFF" }} />
          LIVE
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <StepButton label="1時間もどす" onClick={() => setHour((h) => Math.max(VENUE.open, h - 1))}>
            ◀
          </StepButton>
          <span
            className="cw-mono"
            style={{ fontSize: 26, fontWeight: 700, minWidth: 88, textAlign: "center" }}
          >
            {hour}:00
          </span>
          <StepButton label="1時間すすめる" onClick={() => setHour((h) => Math.min(VENUE.close, h + 1))}>
            ▶
          </StepButton>
        </div>

        <div style={{ fontSize: 14, color: DAY.textDim, lineHeight: 1.5 }}>
          {VENUE.name}
          <br />
          <span style={{ fontSize: 13, color: DAY.textFaint }}>
            {scenario.temp}℃ / 湿度{scenario.rhPct}% / 風{scenario.windMs}m/s
            {clock ? ` ・ 現在 ${clock}` : ""}
          </span>
        </div>

        <button
          onClick={applyLive}
          style={{
            marginLeft: "auto",
            minHeight: 48,
            padding: "0 20px",
            borderRadius: 12,
            border: `1px solid ${DAY.line}`,
            background: DAY.surface,
            color: DAY.text,
            fontSize: 15,
            fontWeight: 700,
            cursor: liveBusy ? "wait" : "pointer",
          }}
        >
          {liveBusy ? "取得中…" : "実況を取り込む"}
        </button>
        {liveAt && (
          <span style={{ fontSize: 13, color: liveAt === "error" ? "#B3123A" : DAY.textFaint }}>
            {liveAt === "error" ? "実況を取得できませんでした" : `実況 ${liveAt} 反映`}
          </span>
        )}
      </div>

      {/* ② いま何が */}
      <section
        style={{
          background: DAY.surface,
          borderRadius: 14,
          border: `1px solid ${DAY.line}`,
          borderLeft: `10px solid ${topBand?.color ?? DAY.line}`,
          padding: "18px 20px",
        }}
      >
        <div style={{ fontSize: 15, color: DAY.textDim, fontWeight: 700 }}>
          {top && top.severity === 3 ? "いま危ないのは" : "いま危険なゾーンはありません"}
        </div>
        {top && top.severity === 3 ? (
          <>
            <div style={{ fontSize: 40, fontWeight: 700, lineHeight: 1.2, margin: "2px 0 8px" }}>
              {top.zone.name}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span
                style={{
                  background: "#E5254A",
                  color: "#FFFFFF",
                  borderRadius: 8,
                  padding: "5px 13px",
                  fontSize: 20,
                  fontWeight: 700,
                }}
              >
                危険
              </span>
              <span className="cw-mono" style={{ fontSize: 19, fontWeight: 700 }}>
                混雑 {top.density} ／ WBGT {top.wbgt}
              </span>
              <span style={{ fontSize: 15, color: DAY.textDim }}>
                要因 {riskCause(top.density, top.wbgt) ?? "—"}
              </span>
              {dangerNow.length > 1 && (
                <span style={{ fontSize: 15, color: DAY.textDim }}>
                  ほか {dangerNow.length - 1} ゾーンが危険
                </span>
              )}
            </div>
            <Why zone={top.zone} hour={hour} scenario={scenario} markHour={hour} />
          </>
        ) : (
          <div style={{ fontSize: 19, marginTop: 6, color: DAY.textDim, lineHeight: 1.7 }}>
            最混雑は {peak.maxDensityZone.name}（{peak.maxDensity}）。
            通常巡回でよい状態です。
          </div>
        )}
      </section>

      {/* ③ この先 — 既存サービスとの差はここ */}
      <section
        style={{
          background: DAY.surface,
          borderRadius: 14,
          border: `1px solid ${DAY.line}`,
          borderLeft: `10px solid ${next ? timeBand(next.hoursToDanger).color : "#22C55E"}`,
          padding: "16px 20px",
        }}
      >
        <div style={{ fontSize: 15, color: DAY.textDim, fontWeight: 700, marginBottom: 4 }}>
          この先
        </div>
        {next ? (
          <>
            <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.5 }}>
              <span className="cw-mono">{next.dangerHour}:00</span> に{" "}
              <span style={{ borderBottom: `3px solid ${timeBand(next.hoursToDanger).color}` }}>
                {next.zone.name}
              </span>{" "}
              が危険になります
            </div>
            <div style={{ fontSize: 15, color: DAY.textDim, marginTop: 6 }}>
              要因 {next.dangerCause ?? "—"} ／ その時点で 混雑 {next.dangerDensity} ・ WBGT{" "}
              {next.dangerWbgt}（現在 混雑 {next.density}）
            </div>
            <Why
              zone={next.zone}
              hour={next.dangerHour!}
              scenario={scenario}
              markHour={hour}
            />
            {upcoming.length > 1 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                {upcoming.slice(1, 5).map((r) => (
                  <span
                    key={r.zone.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      minHeight: 44,
                      padding: "0 14px",
                      borderRadius: 10,
                      border: `1px solid ${DAY.line}`,
                      fontSize: 15,
                    }}
                  >
                    <span
                      style={{
                        width: 11,
                        height: 11,
                        borderRadius: 3,
                        background: timeBand(r.hoursToDanger).color,
                      }}
                    />
                    <span className="cw-mono" style={{ fontWeight: 700 }}>
                      {r.dangerHour}:00
                    </span>
                    {r.zone.name}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 19, color: DAY.textDim, lineHeight: 1.7 }}>
            終演まで、新たに危険帯へ入るゾーンはありません。
          </div>
        )}
      </section>

      {/* ④ 次の行動 */}
      <section
        style={{
          background: DAY.surface,
          borderRadius: 14,
          border: `1px solid ${DAY.line}`,
          padding: "16px 20px",
        }}
      >
        <button
          onClick={askDirective}
          style={{
            width: "100%",
            minHeight: 60,
            borderRadius: 12,
            border: "none",
            background: aiBusy ? "#93A3C0" : "#0B111F",
            color: "#FFFFFF",
            fontSize: 20,
            fontWeight: 700,
            cursor: aiBusy ? "wait" : "pointer",
          }}
        >
          {aiBusy ? "起草中…" : "やるべきことを出す"}
        </button>
        {directive && (
          <div
            style={{
              marginTop: 14,
              fontSize: 16,
              lineHeight: 1.9,
              whiteSpace: "pre-wrap",
              color: DAY.text,
            }}
          >
            {directive}
          </div>
        )}
        {directive && directiveMeta && (
          <div className="cw-mono" style={{ marginTop: 10, fontSize: 13, color: DAY.textFaint }}>
            {directiveMeta.servedModel} ／ {(directiveMeta.latencyMs / 1000).toFixed(1)}s ／{" "}
            {formatYen(costYenForMeta({ ...directiveMeta, servedModel: directiveMeta.servedModel }))}
            （トークン実測×公表単価）
          </div>
        )}
        {!directive && !aiBusy && (
          <p style={{ margin: "10px 0 0", fontSize: 14, color: DAY.textFaint, lineHeight: 1.7 }}>
            いま危険なゾーンと、この先危険になるゾーンをそのまま渡して指示書を起草します。
            予報の計算そのものにLLMは使っていません。
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * 「なぜそうなるのか」。1日の推移グラフ＋計算から出した根拠の行。
 *
 * ⚠ **ここをLLMに書かせない。** 安全系で「なぜ」を生成文にすると事実を和らげる側に倒れる
 * （08-12にAIが混雑100の経路を「比較的空いています」と書いた事故がある）。
 * 数字は `explainDanger()` がエンジンを問い直して出したもので、言葉はテンプレート。
 */
function Why({
  zone,
  hour,
  scenario,
  markHour,
}: {
  zone: Zone;
  hour: number;
  scenario: Scenario;
  markHour: number;
}) {
  const [open, setOpen] = useState(false);
  const reason = useMemo(() => explainDanger(zone, hour, scenario), [zone, hour, scenario]);
  const curve = useMemo(() => zoneDayCurve(zone, scenario), [zone, scenario]);

  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${DAY.line}`, paddingTop: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          minHeight: 44,
          padding: "0 16px",
          borderRadius: 10,
          border: `1px solid ${DAY.line}`,
          background: DAY.surface,
          color: DAY.text,
          fontSize: 15,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        なぜ？ {open ? "▲" : "▼"}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <DayCurve curve={curve} markHour={markHour} focusHour={hour} />
          <ul style={{ margin: "12px 0 0", paddingLeft: 20, fontSize: 15, lineHeight: 1.9 }}>
            {reason.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
            <li>
              物理的には {evidenceLabel(zone.kind, reason.density)}
              （較正の根拠はデータ設計タブ）
            </li>
          </ul>
          <p style={{ margin: "10px 0 0", fontSize: 13, color: DAY.textFaint, lineHeight: 1.7 }}>
            数字はすべて予報エンジンの計算。この根拠の作成にAIは使っていません。
          </p>
        </div>
      )}
    </div>
  );
}

/** ゾーンの1日の混雑推移。危険帯の時刻を色で打つ */
function DayCurve({
  curve,
  markHour,
  focusHour,
}: {
  curve: CurvePoint[];
  markHour: number;
  focusHour: number;
}) {
  const W = 620;
  const H = 132;
  const padL = 34;
  const padB = 22;
  const x = (h: number) =>
    padL + ((h - curve[0].hour) / (curve[curve.length - 1].hour - curve[0].hour)) * (W - padL - 12);
  const y = (d: number) => H - padB - (d / 100) * (H - padB - 10);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label={`このゾーンの1日の混雑推移。危険帯に入る時刻を色で示す`}
    >
      {[0, 50, 75, 100].map((v) => (
        <g key={v}>
          <line
            x1={padL}
            y1={y(v)}
            x2={W - 12}
            y2={y(v)}
            stroke={v === 75 ? "#E5254A" : DAY.line}
            strokeWidth={v === 75 ? 1.4 : 1}
            strokeDasharray={v === 75 ? "5 4" : undefined}
          />
          <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill={DAY.textFaint}>
            {v}
          </text>
        </g>
      ))}
      <polyline
        fill="none"
        stroke={DAY.textDim}
        strokeWidth={2.5}
        points={curve.map((p) => `${x(p.hour)},${y(p.density)}`).join(" ")}
      />
      {curve.map((p) => (
        <g key={p.hour}>
          <circle
            cx={x(p.hour)}
            cy={y(p.density)}
            r={p.hour === focusHour ? 7 : 4.5}
            fill={p.severity === 3 ? "#E5254A" : DAY.surface}
            stroke={p.severity === 3 ? "#E5254A" : DAY.textDim}
            strokeWidth={2}
          />
          {p.hour % 2 === 1 && (
            <text x={x(p.hour)} y={H - 6} textAnchor="middle" fontSize={11} fill={DAY.textFaint}>
              {p.hour}
            </text>
          )}
        </g>
      ))}
      {curve.some((p) => p.hour === markHour) && (
        <line
          x1={x(markHour)}
          y1={6}
          x2={x(markHour)}
          y2={H - padB}
          stroke={DAY.text}
          strokeWidth={1.4}
          strokeDasharray="3 3"
        />
      )}
    </svg>
  );
}

function StepButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: 48,
        height: 48,
        borderRadius: 12,
        border: `1px solid ${DAY.line}`,
        background: DAY.surface,
        color: DAY.text,
        fontSize: 16,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
