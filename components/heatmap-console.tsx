"use client";

import { useMemo, useState } from "react";
import CompareBar from "./compare-bar";
import HeatMap from "./heat-map";
import { INK } from "@/lib/forecast/scales";
import { daylightWindow } from "@/lib/forecast/solar";
import type { HeatConditions, Weather } from "@/lib/forecast/heatfield";

/** 会場の位置。優先01では会場資料から住所を読み取ってジオコーディングする */
const GEO = { lat: 35.6465, lon: 139.7952, tzOffsetHours: 9 }; // 東京・臨海部

const WEATHER: [Weather, string][] = [
  ["sunny", "晴"],
  ["cloudy", "曇"],
  ["rainy", "雨"],
];

const COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
const compassName = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

export default function HeatmapConsole() {
  const [month, setMonth] = useState(8);
  const [day, setDay] = useState(9);
  const [hours, setHours] = useState(14);
  const [airTemp, setAirTemp] = useState(34);
  const [humidity, setHumidity] = useState(65);
  const [weather, setWeather] = useState<Weather>("sunny");
  const [windFromDeg, setWindFromDeg] = useState(180);
  const [windSpeed, setWindSpeed] = useState(2.5);

  const conditions: HeatConditions = useMemo(
    () => ({
      date: new Date(Date.UTC(2026, month - 1, day)),
      hours,
      geo: GEO,
      airTemp,
      humidity,
      weather,
      windFromDeg,
      windSpeed,
    }),
    [month, day, hours, airTemp, humidity, weather, windFromDeg, windSpeed]
  );

  const daylight = useMemo(
    () => daylightWindow(new Date(Date.UTC(2026, month - 1, day)), GEO),
    [month, day]
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
        <CompareBar />

        <header style={{ marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>
            暑熱ヒートマップ（試作）
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: INK.textDim, lineHeight: 1.8, maxWidth: 760 }}>
            ゾーンごとの代表値ではなく、会場を8px格子（125×88）に切って1セルずつ暑さ指数を計算します。
            太陽位置は緯度経度と日時からの実計算、地表面の材質と建物の影、風による冷却と風下の淀みを含みます。
          </p>
        </header>

        <div className="hm-split" style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", gap: 14 }}>
          <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <Panel title="日時と場所">
              <Row label="月">
                <input type="range" min={1} max={12} value={month} onChange={(e) => setMonth(+e.target.value)} />
                <Val>{month}月</Val>
              </Row>
              <Row label="日">
                <input type="range" min={1} max={28} value={day} onChange={(e) => setDay(+e.target.value)} />
                <Val>{day}日</Val>
              </Row>
              <Row label="時刻">
                <input type="range" min={5} max={21} step={0.25} value={hours} onChange={(e) => setHours(+e.target.value)} />
                <Val>{fmt(hours)}</Val>
              </Row>
              <div className="cw-mono" style={{ fontSize: 10.5, color: INK.textFaint, lineHeight: 1.7, marginTop: 4 }}>
                {GEO.lat}N {GEO.lon}E ／ UTC+{GEO.tzOffsetHours}
                <br />
                {daylight ? `日の出 ${fmt(daylight.sunrise)} ／ 日の入り ${fmt(daylight.sunset)}` : "—"}
              </div>
            </Panel>

            <Panel title="気象">
              <Row label="気温">
                <input type="range" min={20} max={40} value={airTemp} onChange={(e) => setAirTemp(+e.target.value)} />
                <Val>{airTemp}℃</Val>
              </Row>
              <Row label="湿度">
                <input type="range" min={30} max={95} value={humidity} onChange={(e) => setHumidity(+e.target.value)} />
                <Val>{humidity}%</Val>
              </Row>
              <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>
                {WEATHER.map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => setWeather(k)}
                    aria-pressed={weather === k}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: 9,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: `1px solid ${weather === k ? INK.accent : INK.line}`,
                      background: weather === k ? INK.accent : "transparent",
                      color: weather === k ? INK.page : INK.textDim,
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <Row label="風向">
                <input type="range" min={0} max={359} value={windFromDeg} onChange={(e) => setWindFromDeg(+e.target.value)} />
                <Val>
                  {compassName(windFromDeg)} {windFromDeg}°
                </Val>
              </Row>
              <Row label="風速">
                <input type="range" min={0} max={12} step={0.5} value={windSpeed} onChange={(e) => setWindSpeed(+e.target.value)} />
                <Val>{windSpeed}m/s</Val>
              </Row>
            </Panel>

            <Panel title="この計算の内訳">
              <dl style={{ margin: 0, fontSize: 11.5, lineHeight: 1.85, color: INK.textDim }}>
                <dt style={{ color: INK.text, fontWeight: 600 }}>実式</dt>
                <dd style={{ margin: "0 0 8px" }}>
                  屋内WBGT近似 <span className="cw-mono">0.567·Ta + 0.393·e + 3.94</span>（環境省の簡易式）／
                  水蒸気圧はTetensの式／太陽位置はNOAAの近似式
                </dd>
                <dt style={{ color: INK.text, fontWeight: 600 }}>簡易モデル</dt>
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
            <HeatMap conditions={conditions} />
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
        <span style={{ fontSize: 12, color: INK.textDim }}>{label}</span>
        {arr[1]}
      </div>
      {arr[0]}
    </div>
  );
}

function Val({ children }: { children: React.ReactNode }) {
  return (
    <span className="cw-mono" style={{ fontSize: 12.5, fontWeight: 600, color: INK.text }}>
      {children}
    </span>
  );
}
