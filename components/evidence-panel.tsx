"use client";

import { INK } from "@/lib/forecast/scales";
import { EVIDENCE_SOURCES, INDEX100_PERSONS_PER_SQM } from "@/lib/forecast/evidence";

/**
 * 「モデルの根拠と限界」— データ設計タブの下段。
 *
 * 2026-08-13 新設（ユーザー指摘「モデルの根拠が薄い」への回答）。
 * 裏付け済みの部分とヒューリスティックの部分を**分けて正直に書く**。
 * 出典の信頼度も3段階で表記する（一次確認済み / 二次資料 / 推定）。
 * 較正の実体は lib/forecast/evidence.ts（危険帯閾値75の物理的整合はテストで固定）。
 */
export default function EvidencePanel() {
  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 980, marginTop: 14 }}>
      <section style={card}>
        <h2 style={h2}>モデルの根拠と限界</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#22C55E", marginBottom: 6 }}>文献・物理で裏付けている部分</div>
            <ul style={ul}>
              <li>WBGT — 物理計算（Kasten-Young日射→Stull湿球→黒球合成）。馬場v4原本と82アサーション一致</li>
              <li>暑熱の段階 — 環境省の暑さ指数区分（25/28/31℃）</li>
              <li>混雑指数の危険帯（75）— 人/m²に較正し、滞留系 ≈4.1人/m²（ジャム密度帯）・通路系 ≈2.0人/m²（Fruin LOS E/F境界帯）に整合することをテストで固定</li>
              <li>経路探索の混雑ペナルティ非線形性 — 群集事故リスクは閾値超で急増（Fruin・明石の実測）</li>
              <li>段階色 — ΔE検証済み（色覚型でも隣接段が判別可能）</li>
            </ul>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#FB923C", marginBottom: 6 }}>ヒューリスティックな部分（観測で正す設計）</div>
            <ul style={ul}>
              <li>在場率カーブ・ゾーン係数 — 実測代替の仮定値。<b style={{ color: INK.text }}>実運用では入退場ログ・カメラで較正する</b>（それまでの間はナウキャスト補正が観測とのずれを埋める — 当日「調整」の仕組みそのもの）</li>
              <li>タイムテーブル需要倍率（演目中1.5倍・幕間1.35倍）— 現場定説の式化。同上</li>
              <li>退場の分岐比率・通路幅 — デモ会場の想定値（コードに明記）</li>
            </ul>
          </div>
        </div>
        <div style={{ marginTop: 10, fontSize: 12.5, color: INK.textDim }}>
          較正定数（指数100 = 何人/m²）: 滞留系 {INDEX100_PERSONS_PER_SQM.queue} ／ 屋内系 {INDEX100_PERSONS_PER_SQM.indoor} ／ 通路系 {INDEX100_PERSONS_PER_SQM.corridor}
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>出典（信頼度を3段階で表記）</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {["主張", "値", "信頼度", "出典"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EVIDENCE_SOURCES.map((s, i) => (
              <tr key={i}>
                <td style={td}>{s.claim}</td>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{s.value}</td>
                <td style={{ ...td, color: s.confidence === "一次確認済み" ? "#22C55E" : s.confidence === "二次資料" ? "#FDE047" : "#FB923C" }}>{s.confidence}</td>
                <td style={{ ...td, color: INK.textDim }}>{s.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={card}>
        <h2 style={h2}>データの段階（T0〜T3）と画面の対応</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {["段", "データ", "今の実装", "使う画面"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ["T0 事前", "チケット販売数・タイムテーブル・過去実績・会場図", "手入力＋読解AI＋デモデータ", "計画（予報・計画書）"],
              ["T1 実況", "気象（Open-Meteo実測）", "API接続済み", "計画・当日"],
              ["T2 センシング", "定点カメラの人数", "デモデータ（実接続はCSRNet等でロードマップ）", "当日（調整）"],
              ["T3 現場", "スタッフの報告（1-5ボタン・自由文）", "実装済み（自由文はAIが構造化）", "当日（調整）・スタッフ"],
            ].map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j} style={{ ...td, ...(j === 0 ? { fontWeight: 700, whiteSpace: "nowrap" } : {}) }}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: INK.textDim, lineHeight: 1.8 }}>
          段が進むほど鮮度が高く、信頼度の重みも大きい（カメラ &gt; ボタン報告 &gt; 自由文 &gt; 写真）。
          統合は決定的計算（ナウキャスト）で行い、LLMは自由文・写真の構造化にだけ使う。
        </p>
      </section>
    </div>
  );
}

const card: React.CSSProperties = {
  background: INK.surface,
  border: `1px solid ${INK.line}`,
  borderRadius: 12,
  padding: 18,
};

const h2: React.CSSProperties = { margin: "0 0 12px", fontSize: 16, fontWeight: 700 };

const ul: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9, color: INK.textDim };

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 9px",
  fontSize: 11.5,
  color: INK.textFaint,
  borderBottom: `1px solid ${INK.line}`,
  fontWeight: 600,
};

const td: React.CSSProperties = {
  padding: "7px 9px",
  borderBottom: `1px solid ${INK.hairline}`,
  color: INK.text,
  verticalAlign: "top",
  lineHeight: 1.6,
};
