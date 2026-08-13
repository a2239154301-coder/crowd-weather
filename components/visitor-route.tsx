"use client";

import { useMemo, useState } from "react";
import type { Scenario } from "@/lib/forecast/types";
import { VENUE, zonesFor } from "@/lib/forecast/venue";
import { toPath, shadowsAt, sunAt } from "@/lib/forecast/model";
import { anchorOf, destinationsFor, findRoute, type RoutePreference } from "@/lib/forecast/route";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import { costYenForMeta, formatYen } from "@/lib/ai/pricing";

/**
 * 来場者向けルート案内（馬場氏の要望「救護・給水までのルートをAIで算出して示せたら」）。
 *
 * ⚠ **経路探索はLLMではなく決定的な計算**（lib/forecast/route.ts のダイクストラ法）。
 * 安全に関わる案内で毎回違う答えが返ってはいけないこと、数msで出る処理に
 * 数秒かけたくないこと、そして「計算にLLMを使わない」という本製品の設計方針による。
 * LLMは出た経路を一言で説明するところにだけ使う（やさしい日本語・軽量モデル）。
 */

const PREFERENCES: { key: RoutePreference; label: string; hint: string }[] = [
  { key: "safe", label: "混雑を避ける", hint: "人が少ない道" },
  { key: "cool", label: "日陰を通る", hint: "暑さを避ける" },
  { key: "short", label: "とにかく近い", hint: "最短距離" },
];

type Props = { scenario: Scenario; hour: number };

export default function VisitorRoute({ scenario, hour }: Props) {
  const zones = useMemo(() => zonesFor("in"), []);
  const destinations = useMemo(() => destinationsFor(zones), [zones]);

  /**
   * 行き先の選択肢は**会場内の全ゾーン**。
   * `destinationsFor()` は救護・給水とトイレの2つしか返さないが、自由文では
   * 「物販に行きたい」「ステージへ戻りたい」も来る。解釈結果がプルダウンに無いと
   * 選択肢が空欄になって「解釈を直せる」という前提が崩れるので、ここで広げる。
   * 分かりやすい呼び名がある2つはその表記を優先する。
   */
  const destinationOptions = useMemo<[string, string][]>(() => {
    const friendly = new Map(destinations.map((d) => [d.zone.id, d.label]));
    return zones.map((z) => [z.id, friendly.get(z.id) ?? z.name]);
  }, [zones, destinations]);

  const [fromId, setFromId] = useState("main");
  const [toId, setToId] = useState(destinations[0]?.zone.id ?? "aid");
  const [pref, setPref] = useState<RoutePreference>("safe");

  // ── 自由文での問い合わせ ───────────────────────────────────────
  // LLMは「言い方 → 出発地・行き先・優先条件」の翻訳だけを行い、
  // 経路そのものは下の findRoute（ダイクストラ法）が決定的に計算する。
  // 解釈は必ず画面に出す。安全案内で解釈がブラックボックスだと、
  // 目的地を取り違えても来場者が気づけない。
  const [ask, setAsk] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [intent, setIntent] = useState<{ ok: boolean; text: string } | null>(null);

  async function submitAsk() {
    const q = ask.trim();
    if (!q || askBusy) return;
    setAskBusy(true);
    setIntent(null);
    try {
      const res = await fetch("/api/route-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, fromId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      const r = data.result as {
        understood: boolean;
        fromId?: string;
        toId?: string;
        preference?: RoutePreference;
        interpretation: string;
      };
      if (!r.understood) {
        setIntent({ ok: false, text: r.interpretation });
        return;
      }
      if (r.fromId) setFromId(r.fromId);
      if (r.toId) setToId(r.toId);
      if (r.preference) setPref(r.preference);
      setIntent({ ok: true, text: r.interpretation });
      setNote("");
    } catch {
      setIntent({ ok: false, text: "うまく聞き取れませんでした。下の項目から選んでください。" });
    } finally {
      setAskBusy(false);
    }
  }

  const route = useMemo(
    () => findRoute(zones, fromId, toId, hour, scenario, pref),
    [zones, fromId, toId, hour, scenario, pref]
  );

  const shadows = useMemo(
    () => shadowsAt(hour, scenario.date, scenario.geo),
    [hour, scenario.date, scenario.geo]
  );
  const night = sunAt(hour, scenario.date, scenario.geo).altitudeDeg <= 3;

  // AI説明（任意）。経路が出てから押す。数値は計算結果をそのまま渡す
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteModel, setNoteModel] = useState("");
  const [noteYen, setNoteYen] = useState<number | null>(null);

  async function explain() {
    if (!route || noteBusy) return;
    setNoteBusy(true);
    setNote("");
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "route",
          forecast: {
            注意: route.warnings, // ここと矛盾する文章を書かせない（プロンプト側で禁止）
            出発地: route.steps[0].zone.name,
            目的地: route.steps[route.steps.length - 1].zone.name,
            経路: route.steps.map((s) => s.zone.name),
            距離m: route.meters,
            徒歩分: route.minutes,
            経路上の最大混雑指数: route.maxDensity,
            経路上の最大WBGT: route.maxWbgt,
            日陰率パーセント: Math.round(route.shadeRatio * 100),
            時刻: `${hour}:00`,
            優先条件: PREFERENCES.find((p) => p.key === pref)?.label,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      setNote(data.text ?? "");
      setNoteModel(data.meta?.servedModel ?? "");
      setNoteYen(data.meta ? costYenForMeta(data.meta) : null);
    } catch {
      setNote("説明を取得できませんでした。経路そのものは上の地図のとおりです。");
    } finally {
      setNoteBusy(false);
    }
  }

  const polyline = route ? route.steps.map((s) => anchorOf(s.zone)) : [];

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          background: INK.surface,
          border: `1px solid ${INK.line}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div className="cw-mono" style={{ fontSize: 13, letterSpacing: 1.5, color: INK.textFaint }}>
          SAFE ROUTE ── 言葉で聞ける会場の道案内
        </div>
        <div style={{ fontWeight: 600, fontSize: 15, marginTop: 3 }}>
          いちばん近い道が、いちばん安全とはかぎらない。
        </div>
        <div style={{ fontSize: 13, color: INK.textDim, marginTop: 5, lineHeight: 1.7 }}>
          AIが使われるのは<b style={{ color: INK.text }}>言葉を条件に翻訳するところと、結果を言葉にするところ</b>だけ。
          <b style={{ color: INK.text }}>経路そのものの計算にAIは使っていません</b>
          （毎回同じ答えが出る必要があるため）。翻訳した条件は必ず画面に出すので、
          違っていればその場で直せます。
        </div>

        {/* 自由文での問い合わせ。解釈結果は下の項目に反映され、その場で直せる */}
        <div style={{ display: "flex", gap: 8, marginTop: 13, flexWrap: "wrap" }}>
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitAsk()}
            placeholder="例）日陰を通って救護所に行きたい／トイレ、混んでないところ"
            aria-label="行きたい場所を自由に入力"
            style={{
              flex: "1 1 260px",
              minHeight: 48,
              padding: "0 14px",
              borderRadius: 11,
              border: `1px solid ${INK.line}`,
              background: INK.raised,
              color: INK.text,
              fontSize: 15,
            }}
          />
          <button
            onClick={submitAsk}
            disabled={askBusy}
            style={{
              minHeight: 48,
              padding: "0 22px",
              borderRadius: 11,
              border: "none",
              background: askBusy ? INK.raised : INK.accent,
              color: askBusy ? INK.textDim : INK.page,
              fontWeight: 700,
              fontSize: 15,
              cursor: askBusy ? "wait" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {askBusy ? "聞き取り中…" : "この内容で探す"}
          </button>
        </div>

        {intent && (
          <div
            role="status"
            style={{
              marginTop: 10,
              padding: "11px 13px",
              borderRadius: 10,
              fontSize: 15,
              lineHeight: 1.7,
              background: INK.raised,
              border: `1px solid ${intent.ok ? INK.accent : "#FB7A1E"}55`,
              color: INK.text,
            }}
          >
            <span style={{ color: INK.textDim }}>{intent.ok ? "こう解釈しました：" : "解釈できませんでした："}</span>{" "}
            {intent.text}
            {intent.ok && (
              <div style={{ fontSize: 13, color: INK.textFaint, marginTop: 5 }}>
                違っていたら下の項目で直せます。経路の計算はこの解釈が確定してから行います。
              </div>
            )}
          </div>
        )}

        {/* 入力（自由文の解釈結果がここに反映される） */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
            marginTop: 13,
          }}
        >
          <Labeled label="いまいる場所">
            <Select value={fromId} onChange={setFromId} options={zones.map((z) => [z.id, z.name])} />
          </Labeled>
          <Labeled label="行き先">
            <Select value={toId} onChange={setToId} options={destinationOptions} />
          </Labeled>
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 11, flexWrap: "wrap" }}>
          {PREFERENCES.map((p) => (
            <button
              key={p.key}
              onClick={() => setPref(p.key)}
              aria-pressed={pref === p.key}
              style={{
                flex: "1 1 130px",
                padding: "9px 10px",
                borderRadius: 10,
                border: `1px solid ${pref === p.key ? INK.accent : INK.line}`,
                background: pref === p.key ? INK.accent : "transparent",
                color: pref === p.key ? INK.page : INK.textDim,
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 13,
                lineHeight: 1.4,
              }}
            >
              {p.label}
              <div style={{ fontSize: 13, fontWeight: 400, opacity: 0.8 }}>{p.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {!route && (
        <div
          style={{
            background: INK.surface,
            border: `1px dashed ${INK.line}`,
            borderRadius: 14,
            padding: 16,
            fontSize: 13,
            color: INK.textDim,
          }}
        >
          この2地点をつなぐ道が見つかりませんでした。別の場所を選んでください。
        </div>
      )}

      {route && (
        <div className="cw-split" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 12 }}>
          {/* 地図＋経路 */}
          <div
            style={{
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 14,
              padding: 12,
            }}
          >
            <svg
              viewBox={`0 0 ${VENUE.width} ${VENUE.height}`}
              style={{ width: "100%", height: "auto", display: "block", borderRadius: 10 }}
              role="img"
              aria-label={`${route.steps[0].zone.name}から${route.steps[route.steps.length - 1].zone.name}への経路`}
            >
              {VENUE.ground.map((g) => (
                <path key={g.id} d={toPath(g.shape)} fill="#151C2B" />
              ))}
              {!night &&
                shadows.map((s) => (
                  <path key={s.building.id} d={toPath(s.shape)} fill="#050A12" fillOpacity={0.55} />
                ))}
              {VENUE.buildings.map((b) => (
                <path key={b.id} d={toPath(b.shape)} fill="#0D1420" stroke="#2B3A55" strokeWidth={1.2} />
              ))}
              {/* ゾーンは薄く。経路を主役にする */}
              {zones.map((z) => (
                <path
                  key={z.id}
                  d={toPath(z.shape)}
                  fill={INK.raised}
                  fillOpacity={0.55}
                  stroke={INK.line}
                  strokeWidth={1}
                />
              ))}

              {/* 経路 */}
              <polyline
                points={polyline.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="#0A0E17"
                strokeWidth={11}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={polyline.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={INK.accent}
                strokeWidth={5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {route.steps.map((s, i) => {
                const p = anchorOf(s.zone);
                const isEnd = i === route.steps.length - 1;
                const isStart = i === 0;
                return (
                  <g key={s.zone.id}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={isStart || isEnd ? 13 : 8}
                      fill={isEnd ? "#22C55E" : isStart ? INK.text : INK.accent}
                      stroke="#0A0E17"
                      strokeWidth={2.5}
                    />
                    {(isStart || isEnd) && (
                      <text
                        x={p.x}
                        y={p.y + 5}
                        textAnchor="middle"
                        fontSize={13}
                        fontWeight={700}
                        fill="#0A0E17"
                      >
                        {isStart ? "現" : "着"}
                      </text>
                    )}
                    <text
                      x={p.x}
                      y={p.y - 20}
                      textAnchor="middle"
                      fontSize={13}
                      fill={INK.text}
                      stroke="#0A0E17"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {s.zone.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* 経路の内訳 */}
          <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <div
              style={{
                background: INK.surface,
                border: `1px solid ${INK.line}`,
                borderRadius: 14,
                padding: 15,
              }}
            >
              <div className="cw-mono" style={{ fontSize: 26, fontWeight: 700, color: INK.text }}>
                徒歩 約{route.minutes}分
                <span style={{ fontSize: 13, color: INK.textDim, fontWeight: 400 }}> / {route.meters}m</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                <Chip color={densityBand(route.maxDensity).color}>
                  いちばん混む所 {densityBand(route.maxDensity).label}
                </Chip>
                <Chip color={wbgtBand(route.maxWbgt).color}>
                  暑さ {wbgtBand(route.maxWbgt).label}
                </Chip>
                <Chip color="#7DD3FC">日陰 {Math.round(route.shadeRatio * 100)}%</Chip>
              </div>

              {route.warnings.map((w, i) => (
                <div
                  key={i}
                  role="status"
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "#FB7A1E14",
                    border: "1px solid #FB7A1E55",
                    color: "#FDBA74",
                    fontSize: 13,
                    lineHeight: 1.7,
                  }}
                >
                  {w}
                </div>
              ))}

              <ol style={{ margin: "13px 0 0", paddingLeft: 0, listStyle: "none", display: "grid", gap: 7 }}>
                {route.steps.map((s, i) => (
                  <li key={s.zone.id} style={{ display: "flex", gap: 9, alignItems: "baseline" }}>
                    <span
                      className="cw-mono"
                      style={{
                        fontSize: 13,
                        color: INK.textFaint,
                        border: `1px solid ${INK.line}`,
                        borderRadius: 999,
                        minWidth: 18,
                        textAlign: "center",
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ flex: 1, fontSize: 13 }}>{s.zone.name}</span>
                    <span
                      className="cw-mono"
                      style={{ fontSize: 13, color: densityBand(s.density).color }}
                    >
                      {s.density}
                    </span>
                    <span className="cw-mono" style={{ fontSize: 13, color: "#7DD3FC" }}>
                      日陰{Math.round(s.shadeFraction * 100)}%
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div
              style={{
                background: INK.surface,
                border: `1px solid ${INK.line}`,
                borderRadius: 14,
                padding: 15,
              }}
            >
              <button
                onClick={explain}
                disabled={noteBusy}
                style={{
                  width: "100%",
                  padding: "10px 0",
                  borderRadius: 999,
                  border: `1px solid ${INK.line}`,
                  background: "transparent",
                  color: noteBusy ? INK.textFaint : INK.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: noteBusy ? "wait" : "pointer",
                }}
              >
                {noteBusy ? "説明を作成中…" : "この道を、ことばで説明してもらう"}
              </button>
              {note && (
                <div style={{ marginTop: 11, fontSize: 13, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>
                  {note}
                </div>
              )}
              <div className="cw-mono" style={{ marginTop: 9, fontSize: 13, color: INK.textFaint, lineHeight: 1.6 }}>
                経路 = ダイクストラ法（LLM不使用）
                {noteModel ? ` ／ 説明 = ${noteModel}（${formatYen(noteYen)}）` : ""}
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 13, color: INK.textDim, marginBottom: 5 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "9px 11px",
        borderRadius: 9,
        border: `1px solid ${INK.line}`,
        background: INK.raised,
        color: INK.text,
        fontSize: 13,
      }}
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 13,
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
