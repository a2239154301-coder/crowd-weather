"use client";

import type { CSSProperties, ReactNode } from "react";
import { Database, Zap, Lock } from "lucide-react";
import { DAY } from "@/lib/ui/day-theme";

/**
 * 審査モードの「データ設計」パネル。
 * 2026-08-14、583行の未使用コード（旧 `CrowdWeather` 本体・`PlanDoc`）を道連れにしていた
 * `components/crowd-weather.tsx` から `DataView` だけを切り出した（再設計 §2-6）。
 * モデル層（`lib/forecast/**`）には一切触れておらず、下記の私有パレット `C` と
 * 2つのヘルパーだけで自己完結する。
 *
 * 2026-08-14、明色化（再設計 §3-3）。私有パレットのうち構造色6キー
 * （panel/panel2/deep/line/faint/muted）は `DAY` トークンへ置換。
 * 意味色4キー（heat/busy/caution/cool）はそのまま保持するが、
 * 白地での文字色としては不合格（例: busy #FB923C は白地2.26:1）なので、
 * `Feed` の実装は「文字は墨色（DAY.text）・意味色は左のドットへ」に変更した
 * （§3-4 と同じ「段階色を文字色に使わない」原則）。
 */

// ---- design tokens（旧 crowd-weather.tsx の私有パレット。意味色4キーのみ残す） ----
const C = {
  cool: "#38BDF8",
  caution: "#FBBF24",
  busy: "#FB923C",
  heat: "#EF4444",
};
const mono = "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace";

const Panel = ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => (
  <div style={{ background: DAY.surface, border: `1px solid ${DAY.line}`, borderRadius: 16, ...style }}>
    {children}
  </div>
);
const Eyebrow = ({ children }: { children?: ReactNode }) => (
  <div style={{ fontFamily: mono, fontSize: 13, letterSpacing: 2, color: DAY.textFaint, textTransform: "uppercase" }}>
    {children}
  </div>
);

// ---- データ設計 ----
export function DataView() {
  const open = [
    { n: "人流統計", src: "東京データプラットフォーム", feeds: ["混雑"] },
    { n: "道路ネットワーク・幅員", src: "東京都オープンデータ", feeds: ["混雑"] },
    { n: "駅別乗降者数", src: "東京都・各鉄道", feeds: ["混雑"] },
    { n: "3D都市モデル（建物形状）", src: "PLATEAU", feeds: ["暑熱"] },
    { n: "暑さ指数・気象データ", src: "環境省・気象庁", feeds: ["暑熱"] },
    { n: "イベント情報・クールスポット", src: "東京都オープンデータ", feeds: ["混雑", "暑熱"] },
  ];
  const priv = [
    { n: "チケット販売数", src: "主催者", feeds: ["混雑"], note: "来場規模の最重要変数" },
    { n: "入退場ゲートログ・場内売上", src: "主催者", feeds: ["混雑"] },
    { n: "Wi-Fi／ビーコン滞留実測", src: "自社センシング", feeds: ["混雑"] },
    { n: "カメラ人流センシング", src: "自社センシング", feeds: ["混雑", "暑熱"] },
    { n: "来場者アプリ利用ログ", src: "CROWD WEATHER", feeds: ["混雑", "暑熱"], note: "予報精度を押し上げる実測" },
  ];
  const Feed = ({ f }: { f: string }) => {
    const tone = f === "混雑" ? C.busy : C.heat;
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontFamily: mono,
          fontSize: 13,
          color: DAY.text,
          background: tone + "22",
          border: `1px solid ${tone}44`,
          borderRadius: 99,
          padding: "2px 8px",
        }}
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: "50%", background: tone, flexShrink: 0 }}
        />
        →{f}予測
      </span>
    );
  };
  const Card = ({ d }: { d: { n: string; src: string; feeds: string[]; note?: string } }) => (
    <div style={{ background: DAY.raised, border: `1px solid ${DAY.line}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: DAY.text }}>{d.n}</div>
      <div style={{ fontFamily: mono, fontSize: 13, color: DAY.textFaint, margin: "3px 0 7px" }}>
        {d.src}
        {d.note ? ` ── ${d.note}` : ""}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {d.feeds.map((f) => (
          <Feed key={f} f={f} />
        ))}
      </div>
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
      <Panel style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <Database size={15} color={C.cool} />
          <Eyebrow>東京都オープンデータ 等</Eyebrow>
        </div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>誰でも使える「土台」</div>
        <div style={{ display: "grid", gap: 10 }}>
          {open.map((d, i) => (
            <Card key={i} d={d} />
          ))}
        </div>
        <div style={{ marginTop: 12, fontFamily: mono, fontSize: 13, color: DAY.textFaint, lineHeight: 1.7 }}>
          ※ 3D都市モデルの活用は、2024年度都知事杯受賞作「高解像度熱中症リスクマップ」の系譜。本デモの日陰計算はその簡略版。
        </div>
      </Panel>
      <Panel style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <Zap size={15} color={C.caution} />
          <Eyebrow>民間 × 自社データ</Eyebrow>
        </div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>私たちしか持ち込めない「差」</div>
        <div style={{ display: "grid", gap: 10 }}>
          {priv.map((d, i) => (
            <Card key={i} d={d} />
          ))}
        </div>
        <div
          style={{
            marginTop: 12,
            background: DAY.page,
            border: `1px dashed ${DAY.line}`,
            borderRadius: 11,
            padding: "11px 13px",
            display: "flex",
            gap: 9,
          }}
        >
          <Lock size={14} color={C.caution} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: DAY.textDim, lineHeight: 1.7 }}>
            民間イベントデータは、主催者との信頼関係がなければ集まらない。イベント制作の当事者である私たち自身が「データの持ち込み手」——ここが最大の参入障壁になる。
          </div>
        </div>
      </Panel>
    </div>
  );
}
