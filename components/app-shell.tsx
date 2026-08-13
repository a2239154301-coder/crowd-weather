"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { INK } from "@/lib/forecast/scales";
import { NAV_ACCENT } from "@/lib/ui/day-theme";
import { ThemeProvider, useThemeState } from "@/lib/ui/theme";
import OpsConsole from "./ops-console";
import IngestPanel from "./ingest-panel";
import VisitorRoute from "./visitor-route";
import LiveConsole from "./live-console";
import AdjustConsole from "./adjust-console";
import StaffConsole from "./staff-console";
import StaffBoard from "./staff-board";
import DeploymentEditor from "./deployment/deployment-editor";
import PlanOutput from "./plan-output";
import EvidencePanel from "./evidence-panel";
import { ScenarioProvider } from "@/lib/ui/scenario-context";
import CompareBar from "./compare-bar";
import TrustPanel from "./trust-panel";
import { DataView } from "./data-view";

/**
 * 画面の骨格。2026-08-11 に情報設計を再編（馬場氏要望1）:
 *
 * 従来はフラットな4タブで「誰のための画面か」が読めなかった。
 * 最上位を **使う人** で分け、主催者側は
 * 「読み込む → 条件 → 予報 → 出力」の作業手順をステッパーで示す。
 * 番号は飾りではなく実際の作業順序（このワークフロー自体が製品の主張）。
 *
 * 2026-08-12、最上位を **フェーズ**（準備／当日／来場者）に割り直した。
 * 従来は「準備フェーズ」だけに最適化されていて、いちばん価値が高い
 * 当日の画面が存在しなかった。予報プロダクトの本番は当日の炎天下の現場であって、
 * 事務所のPCではない。
 *
 * 2026-08-13、現場フィードバック（馬場氏）で2点を再編:
 * - データ設計・コストと安全は運営者の業務ではなく審査・技術説明のための情報なので、
 *   計画タブから **審査用モード** へ逃がした（業務メニューに混ぜると操作の
 *   メンタルモデルが崩れる、というUIUXレビューP0指摘）
 * - スタッフ画面は「当日を回す」の一環（状況→調整→スタッフの縦串）なので、
 *   最上位から当日モードの3番目のタブへ移した。最上位は4つのまま
 *
 * 2026-08-13、画面状態を **URLと同期**した（棚卸しF）。従来は useState のみで、
 * リロードすると必ず「計画/予報」に戻り（デモ中の事故要因）、見ている画面を
 * URLで共有できず、ブラウザの戻るも効かなかった。
 * `?mode=live&view=ops&live=board` の形で3つのタブ状態を持つ。
 *
 * 2026-08-14、上記の**作業手順ステッパー**（`STEPS`/`CURRENT_STEPS`）を削除した
 * （馬場氏レビュー項目3・再設計 §2-1）。サブタブと表示内容が重複しており、
 * ステップ2「条件を設定」と3「予報を確認」の遷移先がどちらも `ops` で同一だった。
 */

/**
 * 最上位フェーズのタブ。キーとラベルを1箇所にまとめる
 * （2026-08-14、馬場氏レビュー項目11。従来は許可リスト用の `MODES` とJSXインラインの
 * ラベル配列が別々に存在する二重管理だった。ここから両方を導出する）。
 */
const MODE_TABS = [
  ["plan", "1 制作向け"],
  ["live", "2 現場向け"],
  ["visitor", "3 来場者向け"],
  ["judge", "4 審査向け"],
] as const;
const ORGANIZER_VIEWS = ["ops", "deploy", "output", "ingest"] as const;
const LIVE_VIEWS = ["status", "adjust", "board", "staff"] as const;

type Mode = (typeof MODE_TABS)[number][0];
type OrganizerView = (typeof ORGANIZER_VIEWS)[number];
type LiveView = (typeof LIVE_VIEWS)[number];
const MODES: readonly Mode[] = MODE_TABS.map(([k]) => k);

/**
 * 2026-08-14、主催者サブタブの順序を作業順（予報→読み込み→出力）に並べ替え（項目12）。
 * 同日、人員配置エディタを「予報コンソール」の直後に追加（予報→人員配置→読み込み→出力）。
 * 会場図面の読み込み前でも仮の会場（VENUE既定）に対して配置計画を作り始められるため、
 * 「読み込む」より前に置く（配置計画はSTEPS/CURRENT_STEPS削除後の2点追加で足りる —
 * ここに1タブ追加するだけで、他の描画分岐は変更不要）。
 */
const ORGANIZER_TABS: [OrganizerView, string][] = [
  ["ops", "予報コンソール"],
  ["deploy", "人員配置"],
  ["ingest", "会場を読み込む"],
  ["output", "計画書出力"],
];

/** URLの値は信用しない。許可リストに無ければ既定値へ倒す */
function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/**
 * `useSearchParams` は静的レンダリング時に Suspense 境界を要求する
 * （境界が無いと `next build` が落ちる）。app/page.tsx を触らずに済むよう、
 * 境界はこのファイル内に置く（app/gate/page.tsx と同じ形）。
 * fallback は「/」のプリレンダーHTMLそのものになる。
 *
 * 2026-08-14（テーマ切替の導入時）: **fallback に地色を敷くのをやめた。**
 * ここは `mode` が決まる前（useSearchParams が suspend 中）に描かれるのでテーマを解決できず、
 * 明色を敷けば暗色モードで、暗色を敷けば明色モードで、それぞれ画面いっぱいの違う色の面が出る。
 *
 * 実測（08-14・ブラウザペイン非表示の環境）で、ストリーミングSSRの `<template id="B:0">` と
 * 差し替え先 `<div id="S:0">` が**両方DOMに残っている**状態を観測した。入れ替えスクリプトが
 * 走り切っていない状態で、実機では解消される可能性が高いが確認できない。
 * 残った場合に「100vhの色違いの帯」が出るリスクを避けるため、地色は透明のままにして
 * **`app/globals.css` の body 背景に任せる**（白のちらつき防止という当初の目的はそちらで足りる）。
 */
export default function AppShell() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh" }} />}>
      <AppShellInner />
    </Suspense>
  );
}

function AppShellInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // 描画の正本は state（タブ切替を router の往復待ちにしない）。
  // URLは初期値の供給元であり、かつ state の鏡。
  const [mode, setMode] = useState<Mode>(() => pick(params.get("mode"), MODES, "plan"));
  const [view, setView] = useState<OrganizerView>(() =>
    pick(params.get("view"), ORGANIZER_VIEWS, "ops")
  );
  const [liveView, setLiveView] = useState<LiveView>(() =>
    pick(params.get("live"), LIVE_VIEWS, "status")
  );

  // URL → state。戻る/進む（popstate）と、共有URLを直接開いた場合をここで拾う。
  // 自分で書いたURLでも走るが、同じ値なので React が再描画を打ち切る
  useEffect(() => {
    setMode(pick(params.get("mode"), MODES, "plan"));
    setView(pick(params.get("view"), ORGANIZER_VIEWS, "ops"));
    setLiveView(pick(params.get("live"), LIVE_VIEWS, "status"));
  }, [params]);

  // state → URL。3キーを常に書く（URLを見れば画面が確定する＝そのまま共有できる）。
  // マウント時には書かない（ユーザー操作していないのに履歴を汚さない）
  const syncUrl = useCallback(
    (next: { mode: Mode; view: OrganizerView; live: LiveView }, method: "push" | "replace") => {
      const qs = new URLSearchParams({ mode: next.mode, view: next.view, live: next.live });
      const href = `${pathname}?${qs.toString()}`;
      if (method === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, router]
  );

  /**
   * モードは push＝「戻る」で前のフェーズに戻れる（デモの導線として意味のある単位）。
   * 同じモードの再クリックでは履歴を積まない（戻るのに2回押す羽目になるのを防ぐ）
   */
  const goMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    syncUrl({ mode: m, view, live: liveView }, "push");
  };
  /** サブタブは replace＝履歴をタブ切替で埋めない */
  const goView = (v: OrganizerView) => {
    setView(v);
    syncUrl({ mode, view: v, live: liveView }, "replace");
  };
  const goLive = (l: LiveView) => {
    setLiveView(l);
    syncUrl({ mode, view, live: l }, "replace");
  };

  // 配色テーマ（2026-08-14新設）。制作向け・審査向けは既定=暗色でトグル可、
  // 現場向け・来場者向けは明色固定（lib/ui/theme.ts の MODE_THEME）
  const theme = useThemeState(mode);
  const T = theme.T;

  return (
    <ScenarioProvider>
    <ThemeProvider value={theme}>
    <div style={{ minHeight: "100vh", background: T.page, color: T.text }}>
      <style>{`
        @media (max-width: 900px) {
          .cw-split { grid-template-columns: 1fr !important; }
          .cw-plan  { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div style={{ maxWidth: 1360, margin: "0 auto", padding: "20px 18px 72px" }}>
        <CompareBar />
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: 2 }}>
                CROWD WEATHER
              </h1>
              <span style={{ fontSize: 13, color: T.textDim }}>混雑は、予報できる。</span>
            </div>
          </div>

          {/* 最上位: 誰のための画面か */}
          <div
            role="tablist"
            aria-label="フェーズの切り替え"
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 3,
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 11,
              padding: 3,
            }}
          >
            {MODE_TABS.map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={mode === k}
                onClick={() => goMode(k)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 1,
                  minHeight: 44,
                  padding: "8px 16px",
                  borderRadius: 9,
                  border: "none",
                  cursor: "pointer",
                  background: mode === k ? NAV_ACCENT : "transparent",
                  color: mode === k ? "#FFFFFF" : INK.textDim,
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 700 }}>{label}</span>
              </button>
            ))}
          </div>

          {/* 配色トグル。制作向け・審査向け（既定=暗色）だけに出す。屋外系（現場・来場者）は
              明色固定で判読性を優先するため、ここに出さない（lib/ui/theme.ts 冒頭コメント参照） */}
          {theme.canToggle && (
            <button
              onClick={theme.toggle}
              aria-label={
                theme.name === "night" ? "配色を明色に切り替える" : "配色を暗色に切り替える"
              }
              title={theme.name === "night" ? "明色に切り替える" : "暗色に切り替える"}
              style={{
                minWidth: 44,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 11,
                border: `1px solid ${INK.line}`,
                background: INK.surface,
                color: INK.textDim,
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
              }}
            >
              {theme.name === "night" ? "☀" : "☾"}
            </button>
          )}
        </header>

        {mode === "plan" && (
          <>
            {/* サブタブ */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 14,
              }}
            >
              <nav
                aria-label="主催者メニュー"
                style={{
                  display: "flex",
                  gap: 3,
                  background: T.surface,
                  border: `1px solid ${T.line}`,
                  borderRadius: 10,
                  padding: 3,
                }}
              >
                {ORGANIZER_TABS.map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => goView(k)}
                    aria-current={view === k ? "page" : undefined}
                    style={{
                      minHeight: 44,
                      padding: "8px 15px",
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 600,
                      background: view === k ? T.raised : "transparent",
                      color: view === k ? T.text : T.textDim,
                      boxShadow: view === k ? `inset 0 0 0 1px ${T.line}` : "none",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            </div>

            {view === "ops" && <OpsConsole />}
            {view === "deploy" && <DeploymentEditor />}
            {view === "output" && <PlanOutput />}
            {view === "ingest" && <IngestPanel />}
          </>
        )}

        {mode === "live" && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
              <nav
                aria-label="当日メニュー"
                style={{
                  display: "flex",
                  gap: 3,
                  background: T.surface,
                  border: `1px solid ${T.line}`,
                  borderRadius: 10,
                  padding: 3,
                }}
              >
                {(
                  [
                    ["status", "状況 — いまどこが危ないか"],
                    ["adjust", "調整 — 計画と実際を合わせる"],
                    ["board", "配置 — メンバーを置き、動かす"],
                    ["staff", "スタッフ — 指示を受け、報告する"],
                  ] as [LiveView, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => goLive(k)}
                    aria-current={liveView === k ? "page" : undefined}
                    style={{
                      minHeight: 44,
                      padding: "0 15px",
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 600,
                      background: liveView === k ? T.raised : "transparent",
                      color: liveView === k ? T.text : T.textDim,
                      boxShadow: liveView === k ? `inset 0 0 0 1px ${T.line}` : "none",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <span style={{ fontSize: 13, color: T.textFaint }}>
                屋外・スマホ前提のため当日系の画面は明色
              </span>
            </div>
            {liveView === "status" && <LiveConsole />}
            {liveView === "adjust" && <AdjustConsole onOpenBoard={() => goLive("board")} />}
            {liveView === "board" && <StaffBoard />}
            {liveView === "staff" && (
              <>
                <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textDim, lineHeight: 1.8 }}>
                  現場スタッフのスマホ画面。名前で入場し、配置ポストの指示を受け、
                  現地の混雑・暑さをワンタップで報告する。
                </p>
                <StaffConsole />
              </>
            )}
          </>
        )}

        {mode === "judge" && (
          <>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textDim, lineHeight: 1.8 }}>
              審査員・技術説明のためのページ。運営者の業務画面からは分離している —
              データ設計（何を計算し、何をLLMに任せないか）・数値の出典・
              AIコストと安全対策をここにまとめて開示する。
            </p>
            <div style={{ display: "grid", gap: 16 }}>
              <DataView />
              <EvidencePanel />
              <TrustPanel />
            </div>
          </>
        )}

        {mode === "visitor" && (
          <>
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 13,
                color: T.textDim,
                lineHeight: 1.8,
              }}
            >
              来場者のスマホに届く画面。どこが空いていて、どこが日陰で、救護がどこにあるか —
              これまでスタッフに聞かないと分からなかった情報を手元に。
            </p>
            <VisitorRoute />
          </>
        )}

        <footer
          style={{
            marginTop: 26,
            paddingTop: 14,
            borderTop: `1px solid ${T.hairline}`,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 13,
            color: T.textFaint,
          }}
        >
          <span>事故ゼロと、最高の体験は、両立できる。</span>
          <span>CROWD WEATHER ｜ AI HACK 2026 ｜ powered by OrcaRouter</span>
        </footer>
      </div>
    </div>
    </ThemeProvider>
    </ScenarioProvider>
  );
}
