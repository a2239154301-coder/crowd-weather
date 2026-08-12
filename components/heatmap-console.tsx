"use client";

import { useMemo, useState } from "react";
import HeatMap from "./heat-map";
import HourlyStrip from "./hourly-strip";
import VenueMap from "./venue-map";
import { INK } from "@/lib/forecast/scales";
import { TIME_BANDS } from "@/lib/forecast/risk";
import { daylightWindow } from "@/lib/forecast/solar";
import type { HeatConditions } from "@/lib/forecast/heatfield";
import type { Scenario, Weather } from "@/lib/forecast/types";
import { DEFAULT_SCENARIO, VENUE } from "@/lib/forecast/venue";

/**
 * 会場図の全画面ページ。審査の投影デモで「地図だけ大きく出す」ための画面。
 *
 * 2026-08-12 作り替え。従来このページは独自の緯度経度（35.6465/139.7952）と
 * 独自の month/day/hours を持っていて、本体コンソール（35.6895/139.6917）と
 * 条件が一致していなかった。**同じ条件を二重管理しない**ため、
 * `Scenario` を正本にして本体と同じ型・同じ既定値から出発する。
 *
 * 2つの見え方を同じ条件で切り替える:
 *  - リスク予報 … ゾーン単位。色は「危険帯に入るまでの残り時間」（本体マップと同じ部品）
 *  - 連続場     … 8px格子のWBGT。日陰・地表面・風下の淀みまで見える精細版
 */

const WEATHER: [Weather, string][] = [
  ["sunny", "晴"],
  ["cloudy", "曇"],
  ["rainy", "雨"],
];

const COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
const compassName = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

/** 会場のタイムゾーン。実況・日の出日の入りの表示にだけ使う（JST固定の割り切り） */
const TZ_OFFSET_HOURS = 9;

type View = "risk" | "field";

export default function HeatmapConsole() {
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [hour, setHour] = useState(15);
  const [view, setView] = useState<View>("risk");
  // 風向だけは Scenario に無い（本体は風速しか使わない）。連続場の移流計算のために持つ
  const [windFromDeg, setWindFromDeg] = useState(180);

  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) =>
    setScenario((p) => ({ ...p, [k]: v }));

  const utcDate = useMemo(
    () => new Date(Date.UTC(scenario.date.y, scenario.date.mo - 1, scenario.date.d)),
    [scenario.date]
  );

  /** 連続場の入力。すべて Scenario から導出する（このページ独自の値を持たない） */
  const conditions: HeatConditions = useMemo(
    () => ({
      date: utcDate,
      hours: hour,
      geo: { lat: scenario.geo.lat, lon: scenario.geo.lon, tzOffsetHours: TZ_OFFSET_HOURS },
      airTemp: scenario.temp,
      humidity: scenario.rhPct,
      weather: scenario.weather,
      windFromDeg,
      windSpeed: scenario.windMs,
    }),
    [utcDate, hour, scenario, windFromDeg]
  );

  const daylight = useMemo(
    () =>
      daylightWindow(utcDate, {
        lat: scenario.geo.lat,
        lon: scenario.geo.lon,
        tzOffsetHours: TZ_OFFSET_HOURS,
      }),
    [utcDate, scenario.geo]
  );

  const fmt = (h: number) => {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${hh}:${String(mm).padStart(2, "0")}`;
  };

  return (
    <div style={{ minHeight: "100vh", background: INK.page, color: INK.text }}>
      <style>{`@media (max-width: 900px){ .hm-split{grid-template-columns:1fr !important} }`}</style>
      <div style={{ maxWidth: 1360, margin: "0 auto", padding: "18px 18px 72px" }}>
        <a
          href="/"
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
            marginBottom: 14,
          }}
        >
          ← 予報コンソールに戻る
        </a>

        <header style={{ marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>
            会場図（全画面）
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: INK.textDim, lineHeight: 1.8, maxWidth: 820 }}>
            <b style={{ color: INK.text }}>予報コンソールと同じ画面を、地図だけ大きく出したもの</b>です
            （投影・現場の共有ディスプレイ用）。条件は同じ <span className="cw-mono">Scenario</span> を使っているので、
            数字がコンソールとずれることはありません。
            <b style={{ color: INK.text }}>リスク予報</b>はゾーン単位で「危険帯に入るまでの残り時間」を、
            <b style={{ color: INK.text }}>連続場</b>は会場を8px格子（125×88）に切った1セルごとの暑さ指数を出します。
            太陽位置は緯度経度と日時からの実計算、地表面の材質と建物の影、風による冷却と風下の淀みを含みます。
          </p>
        </header>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 3, background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 9, padding: 3 }}>
            {(
              [
                ["risk", "リスク予報"],
                ["field", "連続場（WBGT）"],
              ] as [View, string][]
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                aria-pressed={view === k}
                style={{
                  minHeight: 44,
                  padding: "0 16px",
                  borderRadius: 7,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  background: view === k ? INK.raised : "transparent",
                  color: view === k ? INK.text : INK.textDim,
                  boxShadow: view === k ? `inset 0 0 0 1px ${INK.line}` : "none",
                }}
              >
                {l}
              </button>
            ))}
          </div>
          {view === "risk" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {[...TIME_BANDS].reverse().map((b) => (
                <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: INK.textDim }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: b.color, display: "inline-block" }} />
                  {b.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <HourlyStrip
          zones={VENUE.zones}
          scenario={scenario}
          hour={hour}
          onHourChange={setHour}
          scopeLabel="会場内＋会場外"
        />

        <div className="hm-split" style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", gap: 14, marginTop: 14 }}>
          <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <Panel title="気象">
              <Row label="気温">
                <input type="range" min={20} max={40} value={scenario.temp} onChange={(e) => set("temp", +e.target.value)} />
                <Val>{scenario.temp}℃</Val>
              </Row>
              <Row label="湿度">
                <input type="range" min={30} max={95} value={scenario.rhPct} onChange={(e) => set("rhPct", +e.target.value)} />
                <Val>{scenario.rhPct}%</Val>
              </Row>
              <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>
                {WEATHER.map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => set("weather", k)}
                    aria-pressed={scenario.weather === k}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      borderRadius: 9,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: `1px solid ${scenario.weather === k ? INK.accent : INK.line}`,
                      background: scenario.weather === k ? INK.accent : "transparent",
                      color: scenario.weather === k ? INK.page : INK.textDim,
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <Row label="風速">
                <input type="range" min={0} max={12} step={0.5} value={scenario.windMs} onChange={(e) => set("windMs", +e.target.value)} />
                <Val>{scenario.windMs}m/s</Val>
              </Row>
              {view === "field" && (
                <Row label="風向">
                  <input type="range" min={0} max={359} value={windFromDeg} onChange={(e) => setWindFromDeg(+e.target.value)} />
                  <Val>
                    {compassName(windFromDeg)} {windFromDeg}°
                  </Val>
                </Row>
              )}
            </Panel>

            <Panel title="来場規模">
              <Row label="チケット">
                <input type="range" min={2000} max={60000} step={1000} value={scenario.tickets} onChange={(e) => set("tickets", +e.target.value)} />
                <Val>{scenario.tickets.toLocaleString()}枚</Val>
              </Row>
              <div className="cw-mono" style={{ fontSize: 12, color: INK.textFaint, lineHeight: 1.7, marginTop: 4 }}>
                {scenario.geo.name} {scenario.geo.lat}N {scenario.geo.lon}E
                <br />
                {scenario.date.label}
                <br />
                {daylight ? `日の出 ${fmt(daylight.sunrise)} ／ 日の入り ${fmt(daylight.sunset)}` : "—"}
              </div>
            </Panel>

            <Panel title="この計算の内訳">
              <dl style={{ margin: 0, fontSize: 13, lineHeight: 1.85, color: INK.textDim }}>
                <dt style={{ color: INK.text, fontWeight: 600 }}>リスク予報</dt>
                <dd style={{ margin: "0 0 8px" }}>
                  混雑が主・暑熱が一段押し上げる合成。色は「危険帯に入るまでの残り時間」で、
                  終演までの時間ループを前方走査して出す。LLMは使わない
                </dd>
                <dt style={{ color: INK.text, fontWeight: 600 }}>連続場</dt>
                <dd style={{ margin: "0 0 8px" }}>
                  日射・地表面の材質・風の冷却と風下の淀み。物理的に妥当な向きと桁で組んだ加減算で、
                  実測でのキャリブレーションはこれから
                </dd>
                <dt style={{ color: INK.text, fontWeight: 600 }}>未実装</dt>
                <dd style={{ margin: 0 }}>放射収支の厳密解／群集そのものの発熱／湿度の空間分布</dd>
              </dl>
            </Panel>
          </aside>

          <section>
            {view === "risk" ? (
              <VenueMap zones={VENUE.zones} hour={hour} scenario={scenario} layer="risk" />
            ) : (
              <HeatMap conditions={conditions} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 12, padding: 15 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 700, letterSpacing: 0.4 }}>{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: INK.textDim }}>{label}</span>
        {arr[1]}
      </div>
      {arr[0]}
    </div>
  );
}

function Val({ children }: { children: React.ReactNode }) {
  return (
    <span className="cw-mono" style={{ fontSize: 13, fontWeight: 600, color: INK.text }}>
      {children}
    </span>
  );
}
