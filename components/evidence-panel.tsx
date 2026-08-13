"use client";

import { DAY } from "@/lib/ui/day-theme";
import { EVIDENCE_SOURCES, INDEX100_PERSONS_PER_SQM, type ConfidenceTag } from "@/lib/forecast/evidence";

/**
 * 「モデルの根拠と限界」— データ設計タブの下段。
 *
 * 2026-08-13 新設（ユーザー指摘「モデルの根拠が薄い」への回答）。
 * 裏付け済みの部分とヒューリスティックの部分を**分けて正直に書く**。
 * 出典の信頼度も3段階で表記する（一次確認済み / 二次資料 / 推定）。
 * 較正の実体は lib/forecast/evidence.ts（危険帯閾値75の物理的整合はテストで固定）。
 *
 * 2026-08-14、明色化（再設計 §3-3・§3-4）。信頼度3段階の元の段階色
 * （#22C55E / #FDE047 / #FB923C）は白地では判読不能（例: #FDE047 は1.32:1）なので、
 * **文字色は墨色系へ、元の段階色は左の小さなドットへ**移した
 * （staff-board.tsx 等で既に使われている #0F6E56 / #B45309 と同系統の色）。
 */

/** 信頼度3段階: 文字色（白地4.5:1以上）と、元の段階色を残すドットの色 */
const CONFIDENCE_TONE: Record<ConfidenceTag, { text: string; dot: string }> = {
  一次確認済み: { text: "#0F6E56", dot: "#22C55E" }, // 白地6.20:1
  二次資料: { text: "#B45309", dot: "#FDE047" }, // 白地5.02:1
  推定: { text: DAY.textFaint, dot: "#FB923C" }, // 白地5.72:1
};
export default function EvidencePanel() {
  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 980, marginTop: 14 }}>
      {/*
        2026-08-14、予報コンソールの「リスク予報」レイヤーを削除し `/heatmap` へ一本化した際
        （再設計 §2-2・§2-5）、この文はプロダクトの中核主張なので消さずここへ移設した。
        審査モードは `/heatmap` のリスク地図とセットで説明できる位置にある。
      */}
      <section style={card}>
        <h2 style={h2}>リスク予報 ── 「いま」ではなく「これから」</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8, color: DAY.textDim }}>
          色は<b style={{ color: DAY.text }}>いまの値ではなく、危険帯に入るまでの残り時間</b>。
          判定は混雑が主で、WBGTが31℃以上のとき段を1つ上げる。
          既存サービスが出せるのは「いま混んでいる場所」まで —
          ここで出しているのは<b style={{ color: DAY.text }}>これから危なくなる場所</b>。
          このリスク地図は <code>/heatmap</code> で全画面表示できる。
        </p>
      </section>

      <section style={card}>
        <h2 style={h2}>モデルの根拠と限界</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#0F6E56", marginBottom: 6 }}>文献・物理で裏付けている部分</div>
            <ul style={ul}>
              <li>WBGT — 物理計算（Kasten-Young日射→Stull湿球→黒球合成）。馬場v4原本と82アサーション一致</li>
              <li>暑熱の段階 — 環境省の暑さ指数区分（25/28/31℃）</li>
              <li>混雑指数の危険帯（75）— 人/m²に較正し、滞留系 ≈4.1人/m²（ジャム密度帯）・通路系 ≈2.0人/m²（Fruin LOS E/F境界帯）に整合することをテストで固定</li>
              <li>経路探索の混雑ペナルティ非線形性 — 群集事故リスクは閾値超で急増（Fruin・明石の実測）</li>
              <li>段階色 — ΔE検証済み（色覚型でも隣接段が判別可能）</li>
            </ul>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#B45309", marginBottom: 6 }}>ヒューリスティックな部分（観測で正す設計）</div>
            <ul style={ul}>
              <li>在場率カーブ・ゾーン係数 — 実測代替の仮定値。<b style={{ color: DAY.text }}>実運用では入退場ログ・カメラで較正する</b>（それまでの間はナウキャスト補正が観測とのずれを埋める — 当日「調整」の仕組みそのもの）</li>
              <li>タイムテーブル需要倍率（演目中1.5倍・幕間1.35倍）— 現場定説の式化。同上</li>
              <li>退場の分岐比率・通路幅 — デモ会場の想定値（コードに明記）</li>
            </ul>
          </div>
        </div>
        <div style={{ marginTop: 10, fontSize: 13, color: DAY.textDim }}>
          較正定数（指数100 = 何人/m²）: 滞留系 {INDEX100_PERSONS_PER_SQM.queue} ／ 屋内系 {INDEX100_PERSONS_PER_SQM.indoor} ／ 通路系 {INDEX100_PERSONS_PER_SQM.corridor}
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>出典（信頼度を3段階で表記）</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {["主張", "値", "信頼度", "出典"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EVIDENCE_SOURCES.map((s, i) => {
              const tone = CONFIDENCE_TONE[s.confidence];
              return (
                <tr key={i}>
                  <td style={td}>{s.claim}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{s.value}</td>
                  <td style={{ ...td, color: tone.text }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span
                        aria-hidden
                        style={{ width: 6, height: 6, borderRadius: "50%", background: tone.dot, flexShrink: 0 }}
                      />
                      {s.confidence}
                    </span>
                  </td>
                  <td style={{ ...td, color: DAY.textDim }}>{s.source}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section style={card}>
        <h2 style={h2}>データの段階（T0〜T3）と画面の対応</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
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
        <p style={{ margin: "10px 0 0", fontSize: 13, color: DAY.textDim, lineHeight: 1.8 }}>
          段が進むほど鮮度が高く、信頼度の重みも大きい（カメラ &gt; ボタン報告 &gt; 自由文 &gt; 写真）。
          統合は決定的計算（ナウキャスト）で行い、LLMは自由文・写真の構造化にだけ使う。
        </p>
      </section>
    </div>
  );
}

const card: React.CSSProperties = {
  background: DAY.surface,
  border: `1px solid ${DAY.line}`,
  borderRadius: 12,
  padding: 18,
};

const h2: React.CSSProperties = { margin: "0 0 12px", fontSize: 15, fontWeight: 700 };

const ul: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9, color: DAY.textDim };

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 9px",
  fontSize: 13,
  color: DAY.textFaint,
  borderBottom: `1px solid ${DAY.line}`,
  fontWeight: 600,
};

const td: React.CSSProperties = {
  padding: "7px 9px",
  borderBottom: `1px solid ${DAY.hairline}`,
  color: DAY.text,
  verticalAlign: "top",
  lineHeight: 1.6,
};
