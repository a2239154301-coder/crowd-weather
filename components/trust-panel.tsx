"use client";

import { useEffect, useState } from "react";
import { useTheme, type Tokens } from "@/lib/ui/theme";
import { ROUTING, type OrcaTask } from "@/lib/ai/orca";
import { PRICES, USD_JPY, estimateEventCost, formatYen } from "@/lib/ai/pricing";

/**
 * 「コストと安全」— 審査項目⑥（LLMコスト）と⑦（セキュリティ）の1枚。
 *
 * 数字の出所を3種類に分けて表記する（混ぜると全部が疑わしくなる）:
 *   1. 実測 … OrcaRouter課金API（/api/usage）の累計と、usageのトークン数
 *   2. 公表単価 … 各プロバイダの公式価格（lib/ai/pricing.ts に出典つきで固定）
 *   3. 概算 … 1×2 の掛け算（1イベント試算など）
 *
 * ルーティング表は orca.ts の ROUTING から生成する（表とコードがズレない）。
 * pricing.test.ts が「ROUTINGの全モデルに単価がある」ことを固定している。
 */

/**
 * PII Shield をダッシュボードで本番キーに適用し、マスクの実効を確認したら true にする。
 * 確認前に「適用済み」と書かない（実際に有効でないものを有効と書かない）。
 *
 * 2026-08-13 検証済み → true。本番キーで直接確認した内容:
 *   - メール → [EMAIL]（標準の pii ルール）
 *   - 日本の携帯番号 → [PHONE]（標準の phone 検出器は日本形式を素通しした実測を受け、
 *     カスタム正規表現 `0[789]0[-\s]?\d{4}[-\s]?\d{4}` を追加。4形式で確認）
 *   - 実アプリ経由（What-if・経路案内）でも構造化出力が壊れないことを確認
 *   - ⚠ 固定電話・+81表記は対象外。**画像読解も対象外**（PII guardrailはテキストのみを
 *     スキャンする — 公式docsに明記。会場資料PDFのPIIは守れない。表示文言もこの範囲に合わせる）
 */
const PII_SHIELD_VERIFIED = true;

const TASK_LABEL: Record<OrcaTask, { label: string; freq: string }> = {
  ingest: { label: "① 会場資料の読解", freq: "会場ごと1回" },
  plan: { label: "② 計画書・総括の起草", freq: "イベントごと数回" },
  advice: { label: "③ 予報の言語化（指示書・説明）", freq: "当日 随時" },
  whatif: { label: "③′ 自由文の翻訳（What-if・ルート）", freq: "随時" },
};

type Usage = { available: boolean; totalUsd?: number; totalYen?: number };

export default function TrustPanel() {
  const { T } = useTheme();
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => setUsage({ available: false }));
  }, []);

  const est = estimateEventCost();

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 980 }}>
      {/* ── A. LLMを呼ぶ場所は設計で3系統に絞ってある ───────────── */}
      <Card
        title="LLMを呼ぶのは3系統だけ"
        note="コスト削減の本命は安いモデルではなく、呼ばない設計"
      >
        <p style={pStyle(T)}>
          混雑指数・WBGT・日陰・リスク予報・経路探索（ダイクストラ法）・「なぜ」の根拠・
          地図描画は<b style={{ color: T.text }}>すべて決定的な計算で、LLM原価は¥0</b>。
          毎秒動く部分にLLMがいないので、来場者が増えてもAI原価は増えない。
          LLMは「非構造の資料を読む」「数値を人の言葉にする」「言葉を条件に翻訳する」の
          3系統だけに使う。
        </p>
        <table style={tableStyle}>
          <thead>
            <tr>
              {["用途", "頻度", "モデル（実測で選定）", "フォールバック", "単価 in/out（$ per 1M tok）"].map((h) => (
                <th key={h} style={thStyle(T)}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(Object.keys(ROUTING) as OrcaTask[]).map((task) => {
              const r = ROUTING[task];
              const displayModel = r.model.startsWith("orcarouter/")
                ? `${r.model}（ルーター）`
                : r.model;
              const priceKey = r.model.startsWith("orcarouter/") ? r.fallbacks[0] : r.model;
              const p = PRICES[priceKey];
              return (
                <tr key={task}>
                  <td style={tdStyle(T)}>{TASK_LABEL[task].label}</td>
                  <td style={tdStyle(T)}>{TASK_LABEL[task].freq}</td>
                  <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)" }}>{displayModel}</td>
                  <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)", color: T.textDim }}>
                    {r.fallbacks.join(" → ")}
                  </td>
                  <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)" }}>
                    {p ? `$${p.inUsd} / $${p.outUsd}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={{ ...pStyle(T), color: T.textFaint, fontSize: 13 }}>
          モデル選定は9モデルの実測ベンチ（scripts/bench.mjs・2026-08-09）による。
          単価は各プロバイダの公表値（OrcaRouterはゼロマークアップ＝上乗せなし）。
        </p>
      </Card>

      {/* ── B. 原価 ─────────────────────────────────── */}
      <Card title="1イベント運用の原価" note="トークン=実測 ／ 単価=公表値 ／ 掛け算=概算">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginBottom: 12 }}>
          <Stat
            label="ハッカソン期間の累計実費（課金APIの実測）"
            value={
              usage === null
                ? "取得中…"
                : usage.available
                  ? `${formatYen(usage.totalYen ?? null)}`
                  : "取得不可"
            }
            sub={
              usage?.available
                ? `$${usage.totalUsd?.toFixed(2)} ／ 参加者クレジット3,000円の${Math.round(((usage.totalYen ?? 0) / 3000) * 100)}%`
                : "OrcaRouter課金APIから取得"
            }
          />
          <Stat
            label="1イベント運用の試算（概算）"
            value={formatYen(est.totalYen)}
            sub={`読解1回＋計画書3回＋指示書10回＋翻訳5回＋ルート説明20回 ／ ${USD_JPY}円/USD換算`}
          />
        </div>

        <table style={tableStyle}>
          <thead>
            <tr>
              {["内訳", "回数", "モデル", "概算"].map((h) => (
                <th key={h} style={thStyle(T)}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {est.rows.map((r, i) => (
              <tr key={i}>
                <td style={tdStyle(T)}>{r.label}</td>
                <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)" }}>{r.calls}</td>
                <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)", color: T.textDim }}>{r.model}</td>
                <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)" }}>{formatYen(r.yen)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...tdStyle(T), fontWeight: 700 }}>合計</td>
              <td style={tdStyle(T)} />
              <td style={tdStyle(T)} />
              <td style={{ ...tdStyle(T), fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                {formatYen(est.totalYen)}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>
            削減施策（すべて実測に基づく判断）
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9, color: T.textDim }}>
            <li>
              <b style={{ color: T.text }}>orcarouter/auto（cheapest）を実測で棄却</b> —
              最安単価のモデルが推論モデルに解決され、45.96秒・出力2,620トークンを消費。
              「トークン単価最安 ≠ 1リクエストの総コスト最安」。タスク別の明示ルーティングに変更
            </li>
            <li>
              <b style={{ color: T.text }}>max_tokens打ち切りの検出</b> —
              推論モデルはthinkingでトークンを使い切り本文0字でHTTP 200を返す。
              finish_reason=length を検出して即エラーにする（orca.ts）。無言の空振り課金を防ぐ
            </li>
            <li>
              <b style={{ color: T.text }}>全呼び出しでusageを回収</b> —
              画面の各AI応答の脇に「¥」を常時表示。原価が見えない機能は削れない
            </li>
          </ul>
        </div>
      </Card>

      {/* ── C. セキュリティ ───────────────────────────── */}
      <Card
        title="セキュリティ"
        note="扱うのは「警備が手薄な時間と場所」を示す文書 — 預けられる設計にする"
      >
        <div style={{ display: "grid", gap: 10 }}>
          <SecRow
            title="① プロンプトを保存しないゲートウェイ（Zero Data Retention）"
            body="OrcaRouterは既定でプロンプト・出力をディスクに書かない（保持するのはトークン数・レイテンシ・HTTPステータスのみ）。上流プロバイダ側の保持（OpenAI 30日等）は別に存在するため、機微データはそもそも送らない設計と併用する。"
          />
          {PII_SHIELD_VERIFIED && (
            <SecRow
              title="② PII Shield — 自由文の個人情報は上流モデルに届く前にマスク"
              body="OrcaRouterのGuardrails（PII Shield＋日本の携帯番号カスタム検出器）を本番キーに適用し、実測で確認済み（2026-08-13・メール4形式と携帯4形式）。What-if・経路案内の自由文にメールアドレスや携帯番号が混ざっても、[EMAIL] [PHONE] に置換されてから上流に送られる。ポリシーはゲートウェイ側でキーに紐づくため、アプリのコード変更ゼロで効く。限界も明記する: 検出はテキストのみで、画像で送る会場資料は対象外（実運用ではアップロード前の墨消しを手順に置く）。"
            />
          )}
          <SecRow
            title={`${PII_SHIELD_VERIFIED ? "③" : "②"} Agent Firewall — AI提案の宛先を、ゲートウェイ側でも検証`}
            body="配置提案（propose_dispatch）をresponse_formatではなくtool呼び出しに変更し、OrcaRouterのAgent Firewallの管轄に入れた（Firewallはtool呼び出しだけを見る）。遮断できることは実測で確認済み（2026-08-13・scripts/firewall-check.mjs）: HTTP 200＋finish_reason=content_filter＋『[blocked by workspace firewall policy: ...]』という形で返る。ただし本番は『監視のみ』に留めている。提案は配列構造のため、実在ゾーン限定の条件を安全に組み切る時間が確保できず、機能を壊すリスクを避けた（OrcaRouter推奨のobserve→shadow→enforceの観測段階）。遮断能力そのものは証明済みで、完全ブロック運用は次の課題として明記する。"
          />
          <SecRow
            title={`${PII_SHIELD_VERIFIED ? "④" : "③"} APIキーはサーバー側に隔離`}
            body="キーは Vercel の環境変数のみに置き、ブラウザに出ない。OrcaRouterを呼ぶ口は lib/ai/orca.ts の1ファイルに集約してあり、キーが外に出ないことをこのファイルだけで検証できる。デモ画面自体も合言葉ゲート（HttpOnly Cookie）の内側。"
          />
          <SecRow
            title={`${PII_SHIELD_VERIFIED ? "⑤" : "④"} デモデータは架空会場`}
            body="「みなと臨海公園 特設会場」は実在しない。実在会場の警備配置・手薄な時間帯を公開リポジトリやデモに含めない。"
          />
        </div>
      </Card>

      {/* ── D. なぜOrcaRouterか ─────────────────────── */}
      <Card title="なぜOrcaRouterか" note="ゲートウェイが1枚あることで成立している設計">
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.95, color: T.textDim }}>
          <li>
            <b style={{ color: T.text }}>1キーで3プロバイダを跨ぐ適材適所</b> —
            読解=GPT-4.1、起草=Claude、言語化=Gemini。直接統合なら3キー・3SDK・3課金アカウント。
            プロバイダを跨ぐフォールバック（Gemini→GPT→Claude）も1プロトコルで書けている
          </li>
          <li>
            <b style={{ color: T.text }}>ゼロマークアップ</b> —
            上流の公表単価がそのまま原価になるので、上の原価表に説明不要の前提が1つ増える
          </li>
          <li>
            <b style={{ color: T.text }}>ルーティングをブラックボックスにしない</b> —
            全応答の X-Orca-* ヘッダとusageを回収し、「どのモデルが・何トークンで・いくらで」を
            その場に表示している
          </li>
          <li>
            <b style={{ color: T.text }}>実測で使い方を決めた</b> —
            autoの棄却・フォールバックのアプリ側実装・モデルIDの/v1/models確認。
            機能を鵜呑みにせず、検証できたものだけをデモの経路に置いている
          </li>
        </ul>
      </Card>
    </div>
  );
}

// module scope（コンポーネント外）なので useTheme は呼べない。呼び出し側で
// 取った T を渡してもらう関数として持つ（2026-08-14、配色テーマ切替対応）
const pStyle = (T: Tokens): React.CSSProperties => ({
  margin: "0 0 12px",
  fontSize: 13,
  lineHeight: 1.85,
  color: T.textDim,
});

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const thStyle = (T: Tokens): React.CSSProperties => ({
  textAlign: "left",
  padding: "7px 10px",
  fontSize: 13,
  color: T.textFaint,
  borderBottom: `1px solid ${T.line}`,
  fontWeight: 600,
  whiteSpace: "nowrap",
});

const tdStyle = (T: Tokens): React.CSSProperties => ({
  padding: "8px 10px",
  borderBottom: `1px solid ${T.hairline}`,
  color: T.text,
  verticalAlign: "top",
});

function Card({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  const { T } = useTheme();
  return (
    <section style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h2>
        <span style={{ fontSize: 13, color: T.textFaint }}>{note}</span>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  const { T } = useTheme();
  return (
    <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 11, padding: "12px 14px" }}>
      <div style={{ fontSize: 13, color: T.textFaint }}>{label}</div>
      <div className="cw-mono" style={{ fontSize: 26, fontWeight: 700, marginTop: 3, color: T.text }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: T.textDim, marginTop: 3, lineHeight: 1.6 }}>{sub}</div>
    </div>
  );
}

function SecRow({ title, body }: { title: string; body: string }) {
  const { T } = useTheme();
  return (
    <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 11, padding: "12px 14px" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{title}</div>
      <div style={{ fontSize: 13, color: T.textDim, marginTop: 5, lineHeight: 1.8 }}>{body}</div>
    </div>
  );
}
