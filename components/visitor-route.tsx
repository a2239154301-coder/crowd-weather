"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Scenario } from "@/lib/forecast/types";
import { VENUE, zonesFor } from "@/lib/forecast/venue";
import { forecastZones, toPath, shadowsAt, sunAt } from "@/lib/forecast/model";
import { anchorOf, destinationsFor, findRoute, type RoutePreference } from "@/lib/forecast/route";
import { INK, densityBand, wbgtBand } from "@/lib/forecast/scales";
import { evidencePlain } from "@/lib/forecast/evidence";
import { costYenForMeta, formatYen } from "@/lib/ai/pricing";
import { useScenario } from "@/lib/ui/scenario-context";
import { DAY } from "@/lib/ui/day-theme";
import SourceTag from "./source-tag";
import VenueMap from "./venue-map";

/**
 * 来場者向けルート案内（馬場氏の要望「救護・給水までのルートをAIで算出して示せたら」）。
 * 2026-08-13、白基調・スナップショット方式に全面改修。
 *
 * ⚠ **経路探索はLLMではなく決定的な計算**（lib/forecast/route.ts のダイクストラ法）。
 * 安全に関わる案内で毎回違う答えが返ってはいけないこと、数msで出る処理に
 * 数秒かけたくないこと、そして「計算にLLMを使わない」という本製品の設計方針による。
 * LLMは出た経路を一言で説明するところにだけ使う（やさしい日本語・軽量モデル）。
 *
 * **スナップショット方式**: 管理者が予報コンソールでシナリオや時刻を動かしても、
 * 来場者が見ている情報が勝手に変わってはいけない（馬場氏指摘）。
 * 「情報を取り込む」を押した瞬間の条件・実時刻だけを固定して使う。
 * `useScenario()` から取るのは最新のシナリオそのものではなく、
 * スナップショットを取り直すための「素材」でしかない。
 */

const PREFERENCES: { key: RoutePreference; label: string; hint: string }[] = [
  { key: "safe", label: "混雑を避ける", hint: "人が少ない道" },
  { key: "cool", label: "日陰を通る", hint: "暑さを避ける" },
  { key: "short", label: "とにかく近い", hint: "最短距離" },
];

type Snapshot = { scenario: Scenario; hour: number; label: string };
type RouteQuery = { fromId: string; toId: string; pref: RoutePreference };

export default function VisitorRoute() {
  const { scenario } = useScenario();
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

  // ── ①情報のスナップショット ─────────────────────────────────
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const take = useCallback(() => {
    const d = new Date();
    const h = Math.max(VENUE.open, Math.min(VENUE.close, d.getHours()));
    setSnap({ scenario, hour: h, label: `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` });
  }, [scenario]);
  useEffect(() => {
    take();
    // 初回のみ自動取得。以降は「情報を取り込む」ボタンでのみ更新する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ②混雑エリア一覧（電車の混雑アプリ式） ──────────────────────
  const crowded = useMemo(() => {
    if (!snap) return [];
    return forecastZones(VENUE.zones, snap.hour, snap.scenario)
      .filter((f) => f.density >= 80)
      .sort((a, b) => b.density - a.density);
  }, [snap]);

  // ── ④経路探索（既存ロジックを流用） ────────────────────────────
  const [fromId, setFromId] = useState("main");
  const [toId, setToId] = useState(destinations[0]?.zone.id ?? "aid");
  const [pref, setPref] = useState<RoutePreference>("safe");
  // 選んだだけでは検索しない。「この内容で探す」を押した内容だけを確定させる
  const [query, setQuery] = useState<RouteQuery | null>(null);

  const search = useCallback(() => {
    if (!snap) return;
    setQuery({ fromId, toId, pref });
  }, [snap, fromId, toId, pref]);

  // ── 自由文での問い合わせ（補助） ─────────────────────────────
  // LLMは「言い方 → 出発地・行き先・優先条件」の翻訳だけを行い、
  // 経路そのものは findRoute（ダイクストラ法）が決定的に計算する。
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
      const nextFrom = r.fromId ?? fromId;
      const nextTo = r.toId ?? toId;
      const nextPref = r.preference ?? pref;
      if (r.fromId) setFromId(r.fromId);
      if (r.toId) setToId(r.toId);
      if (r.preference) setPref(r.preference);
      setIntent({ ok: true, text: r.interpretation });
      setNote("");
      setQuery({ fromId: nextFrom, toId: nextTo, pref: nextPref });
    } catch {
      setIntent({ ok: false, text: "うまく聞き取れませんでした。上の項目から選んでください。" });
    } finally {
      setAskBusy(false);
    }
  }

  const route = useMemo(() => {
    if (!snap || !query) return null;
    return findRoute(zones, query.fromId, query.toId, snap.hour, snap.scenario, query.pref);
  }, [zones, snap, query]);

  const shadows = useMemo(
    () => (snap ? shadowsAt(snap.hour, snap.scenario.date, snap.scenario.geo) : []),
    [snap]
  );
  const night = snap ? sunAt(snap.hour, snap.scenario.date, snap.scenario.geo).altitudeDeg <= 3 : false;

  // AI説明（任意）。経路が出てから押す。数値は計算結果をそのまま渡す
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteModel, setNoteModel] = useState("");
  const [noteYen, setNoteYen] = useState<number | null>(null);

  async function explain() {
    if (!route || !snap || !query || noteBusy) return;
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
            時刻: `${snap.hour}:00`,
            優先条件: PREFERENCES.find((p) => p.key === query.pref)?.label,
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
      {/* ヘッダ */}
      <div
        style={{
          background: DAY.surface,
          border: `1px solid ${DAY.line}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="cw-mono" style={{ fontSize: 13, letterSpacing: 1.5, color: DAY.textFaint }}>
              SAFE ROUTE — いま混んでいる場所と、安全な道
            </div>
            <div style={{ fontSize: 13, color: DAY.textDim, marginTop: 4 }}>
              {snap ? `${snap.label} 時点の情報` : "情報を取得中…"}
            </div>
          </div>
          <button
            onClick={take}
            style={{
              minHeight: 48,
              padding: "0 20px",
              borderRadius: 11,
              border: "none",
              background: DAY.text,
              color: "#FFFFFF",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            情報を取り込む
          </button>
        </div>
      </div>

      {/* 混雑エリア一覧 */}
      <div
        style={{
          background: DAY.surface,
          border: `1px solid ${DAY.line}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: DAY.text }}>いま混んでいる場所</div>
          <SourceTag kind="calc" tone="day" />
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
          電車の混雑アプリのように、混雑指数80以上のエリアだけを並べています。
          避けるかどうかは、これを見てご自身で判断してください。
        </p>
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          {!snap ? (
            <div style={{ fontSize: 13, color: DAY.textFaint }}>情報を取得中…</div>
          ) : crowded.length === 0 ? (
            <div style={{ fontSize: 15, color: DAY.textDim }}>いま、混雑80以上のエリアはありません</div>
          ) : (
            crowded.map((f) => (
              <div
                key={f.zone.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 11px",
                  background: DAY.page,
                  borderRadius: 10,
                }}
              >
                <span
                  aria-hidden
                  style={{ width: 11, height: 11, borderRadius: 999, background: densityBand(f.density).color, flex: "none" }}
                />
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: DAY.text }}>{f.zone.name}</span>
                <span className="cw-mono" style={{ fontSize: 15, fontWeight: 700, color: DAY.text }}>
                  {f.density}
                </span>
                <span style={{ fontSize: 13, color: DAY.textDim }}>{evidencePlain(f.zone.kind, f.density)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 会場マップ */}
      <div
        style={{
          background: DAY.surface,
          border: `1px solid ${DAY.line}`,
          borderRadius: 14,
          padding: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: DAY.textDim, marginBottom: 8, padding: "0 4px" }}>
          会場マップ（混雑）
        </div>
        {snap ? (
          <VenueMap zones={VENUE.zones} hour={snap.hour} scenario={snap.scenario} layer="crowd" compact />
        ) : (
          <div style={{ fontSize: 13, color: DAY.textFaint, padding: "0 4px" }}>情報を取得中…</div>
        )}
      </div>

      {/* 経路探索（一本導線） */}
      <div
        style={{
          background: DAY.surface,
          border: `1px solid ${DAY.line}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, color: DAY.text }}>安全な道を探す</div>
        <p style={{ margin: "4px 0 12px", fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
          経路の計算にAIは使っていません（毎回同じ答えが出る決定的な計算です）。
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          <Labeled label="① いまいる場所">
            <Select value={fromId} onChange={setFromId} options={zones.map((z) => [z.id, z.name])} />
          </Labeled>
          <Labeled label="② 行き先">
            <Select value={toId} onChange={setToId} options={destinationOptions} />
          </Labeled>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: DAY.textDim, marginBottom: 6 }}>③ 条件</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PREFERENCES.map((p) => (
              <button
                key={p.key}
                onClick={() => setPref(p.key)}
                aria-pressed={pref === p.key}
                style={{
                  flex: "1 1 130px",
                  minHeight: 48,
                  padding: "9px 10px",
                  borderRadius: 10,
                  border: `1px solid ${pref === p.key ? DAY.text : DAY.line}`,
                  background: pref === p.key ? DAY.text : DAY.surface,
                  color: pref === p.key ? "#FFFFFF" : DAY.text,
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 13,
                  lineHeight: 1.4,
                }}
              >
                {p.label}
                <div style={{ fontSize: 13, fontWeight: 400, opacity: 0.85 }}>{p.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={search}
          disabled={!snap}
          style={{
            marginTop: 14,
            width: "100%",
            minHeight: 48,
            padding: "0 22px",
            borderRadius: 11,
            border: "none",
            background: snap ? DAY.text : DAY.line,
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: 15,
            cursor: snap ? "pointer" : "not-allowed",
          }}
        >
          ④ この内容で探す
        </button>

        {!query && (
          <div style={{ marginTop: 10, fontSize: 13, color: DAY.textFaint }}>
            条件を選んで「この内容で探す」を押すと、ここに経路が表示されます。
          </div>
        )}
      </div>

      {query && !route && (
        <div
          style={{
            background: DAY.surface,
            border: `1px dashed ${DAY.line}`,
            borderRadius: 14,
            padding: 16,
            fontSize: 13,
            color: DAY.textDim,
          }}
        >
          この2地点をつなぐ道が見つかりませんでした。別の場所を選んでください。
        </div>
      )}

      {query && route && (
        <div className="cw-split" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 12 }}>
          {/* 地図＋経路（安全案内の主役なので、既存の暗色SVGのまま） */}
          <div
            style={{
              background: DAY.surface,
              border: `1px solid ${DAY.line}`,
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
                background: DAY.surface,
                border: `1px solid ${DAY.line}`,
                borderRadius: 14,
                padding: 15,
              }}
            >
              <div className="cw-mono" style={{ fontSize: 26, fontWeight: 700, color: DAY.text }}>
                徒歩 約{route.minutes}分
                <span style={{ fontSize: 13, color: DAY.textDim, fontWeight: 400 }}> / {route.meters}m</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                <Chip color={densityBand(route.maxDensity).color}>
                  いちばん混む所 {densityBand(route.maxDensity).label}
                </Chip>
                <Chip color={wbgtBand(route.maxWbgt).color}>暑さ {wbgtBand(route.maxWbgt).label}</Chip>
                <Chip color="#38BDF8">日陰 {Math.round(route.shadeRatio * 100)}%</Chip>
              </div>

              {route.warnings.map((w, i) => (
                <div
                  key={i}
                  role="status"
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    borderRadius: "0 10px 10px 0",
                    background: "#FB7A1E14",
                    borderLeft: "5px solid #FB7A1E",
                    color: DAY.text,
                    fontSize: 13,
                    lineHeight: 1.7,
                  }}
                >
                  {w}
                </div>
              ))}

              <ol style={{ margin: "13px 0 0", paddingLeft: 0, listStyle: "none", display: "grid", gap: 7 }}>
                {route.steps.map((s, i) => (
                  <li key={s.zone.id} style={{ display: "flex", gap: 9, alignItems: "center" }}>
                    <span
                      className="cw-mono"
                      style={{
                        fontSize: 13,
                        color: DAY.textFaint,
                        border: `1px solid ${DAY.line}`,
                        borderRadius: 999,
                        minWidth: 18,
                        textAlign: "center",
                      }}
                    >
                      {i + 1}
                    </span>
                    <span
                      aria-hidden
                      style={{ width: 9, height: 9, borderRadius: 999, background: densityBand(s.density).color, flex: "none" }}
                    />
                    <span style={{ flex: 1, fontSize: 13, color: DAY.text }}>{s.zone.name}</span>
                    <span className="cw-mono" style={{ fontSize: 13, color: DAY.textDim }}>
                      {s.density}
                    </span>
                    <span className="cw-mono" style={{ fontSize: 13, color: DAY.textDim }}>
                      日陰{Math.round(s.shadeFraction * 100)}%
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div
              style={{
                background: DAY.surface,
                border: `1px solid ${DAY.line}`,
                borderRadius: 14,
                padding: 15,
              }}
            >
              <div style={{ marginBottom: 9 }}>
                <SourceTag kind="ai" tone="day" />
              </div>
              <button
                onClick={explain}
                disabled={noteBusy}
                style={{
                  width: "100%",
                  minHeight: 48,
                  padding: "10px 0",
                  borderRadius: 999,
                  border: `1px solid ${DAY.line}`,
                  background: DAY.page,
                  color: noteBusy ? DAY.textFaint : DAY.text,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: noteBusy ? "wait" : "pointer",
                }}
              >
                {noteBusy ? "説明を作成中…" : "この道を、ことばで説明してもらう"}
              </button>
              {note && (
                <div style={{ marginTop: 11, fontSize: 13, lineHeight: 1.9, whiteSpace: "pre-wrap", color: DAY.text }}>
                  {note}
                </div>
              )}
              <div className="cw-mono" style={{ marginTop: 9, fontSize: 13, color: DAY.textFaint, lineHeight: 1.6 }}>
                経路 = ダイクストラ法（LLM不使用）
                {noteModel ? ` ／ 説明 = ${noteModel}（${formatYen(noteYen)}）` : ""}
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* 自由文入力（補助手段） */}
      <div
        style={{
          background: DAY.surface,
          border: `1px solid ${DAY.line}`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, color: DAY.text }}>ことばで探す（補助）</div>
        <p style={{ margin: "4px 0 12px", fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
          話し言葉のままでも探せます。AIが読み取った内容は必ず下に表示するので、
          違っていたら上の①〜③の項目から選び直してください
          （<b style={{ color: DAY.text }}>経路そのものの計算にAIは使っていません</b>）。
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
              border: `1px solid ${DAY.line}`,
              background: DAY.page,
              color: DAY.text,
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
              background: askBusy ? DAY.line : DAY.text,
              color: "#FFFFFF",
              fontWeight: 700,
              fontSize: 15,
              cursor: askBusy ? "wait" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {askBusy ? "聞き取り中…" : "ことばで探す"}
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
              background: DAY.page,
              border: `1px solid ${intent.ok ? DAY.line : "#FB7A1E"}`,
              color: DAY.text,
            }}
          >
            <span style={{ color: DAY.textDim }}>
              {intent.ok ? "こう解釈しました：" : "解釈できませんでした："}
            </span>{" "}
            {intent.text}
            {intent.ok && (
              <div style={{ fontSize: 13, color: DAY.textFaint, marginTop: 5 }}>
                上の「安全な道を探す」欄に反映し、その内容で経路を表示しました。
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 13, color: DAY.textDim, marginBottom: 5 }}>{label}</span>
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
        minHeight: 48,
        padding: "0 11px",
        borderRadius: 9,
        border: `1px solid ${DAY.line}`,
        background: DAY.surface,
        color: DAY.text,
        fontSize: 15,
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

/** 段階色は塗り・ドットにだけ使い、文字は必ず墨色（day-theme.ts の運用ルール） */
function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        fontWeight: 600,
        color: DAY.text,
        background: `${color}1A`,
        border: `1px solid ${color}66`,
        borderRadius: 999,
        padding: "4px 10px 4px 8px",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: "none" }} />
      {children}
    </span>
  );
}
