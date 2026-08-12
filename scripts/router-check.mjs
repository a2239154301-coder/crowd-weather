/**
 * 名前付きルーターの採否ゲート — 審査⑤の「ダッシュボードでコード無変更のまま方針変更」を
 * デモの経路に載せてよいかを実測で決める。
 *
 *   node scripts/router-check.mjs [router-name]   （既定: cw-advice）
 *
 * 前提: OrcaRouterダッシュボード（Routing）で名前付きルーターを作成しておくこと。
 *   名前: cw-advice ／ default_model: google/gemini-2.5-flash-lite
 *   許可: google/gemini-2.5-flash-lite, openai/gpt-4o-mini, anthropic/claude-haiku-4.5
 *
 * 合否（3回すべて満たしたら合格）:
 *   1. HTTP 200 で本文が非ゼロ（max_tokens打ち切り・空応答でない）
 *   2. X-Orca-Router / X-Orca-Resolved-Model ヘッダが返る（ルーティングの証拠が取れる）
 *   3. レイテンシが直接指定の3倍以内（autoの45.96秒事故の再発検知）
 *
 * 合格したら lib/ai/orca.ts の ROUTING.advice.model を "orcarouter/cw-advice" に差し替える。
 * 不合格なら差し替えない（08-09のフォールバック検証と同じ方針:
 * 検証できない仕組みにデモの可用性を預けない）。
 */
import { readFileSync } from "node:fs";

const ORCA_BASE = "https://api.orcarouter.ai/v1";
const ROUTER = `orcarouter/${process.argv[2] ?? "cw-advice"}`;
const DIRECT = "google/gemini-2.5-flash-lite";
const RUNS = 3;

function loadKey() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("ORCAROUTER_API_KEY="));
  if (!line) throw new Error(".env.local に ORCAROUTER_API_KEY がありません");
  return line.slice("ORCAROUTER_API_KEY=".length).trim();
}

const SYSTEM = "あなたはイベント運営のAIアドバイザーです。1〜2文で簡潔に答えてください。";

async function call(key, model, question) {
  const t0 = Date.now();
  const res = await fetch(`${ORCA_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: question },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    ms,
    text: data?.choices?.[0]?.message?.content ?? "",
    router: res.headers.get("x-orca-router"),
    resolved: res.headers.get("x-orca-resolved-model"),
    error: data?.error?.message,
  };
}

const key = loadKey();

// ⚠ OrcaRouterは同一プロンプト・低tempの応答をキャッシュする（08-09実測）。
//   質問を毎回変えてキャッシュ経由の見かけ速度で判定しないようにする。
const QUESTIONS = [
  "16時にメインステージの混雑指数が100です。まず何をすべきですか。",
  "WBGTが31を超えた物販の列に、最初に出す指示は何ですか。",
  "終演30分前、駅コンコースの混雑が上がり始めました。何を準備しますか。",
];

console.log(`== 基準: 直接指定 ${DIRECT} ==`);
const base = await call(key, DIRECT, QUESTIONS[0] + "（基準計測）");
console.log(`   ${base.status} ${base.ms}ms 本文${base.text.length}字`);
if (!base.ok) {
  console.error("基準計測が失敗。ネットワークかキーの問題なので判定を中止します。");
  process.exit(2);
}

console.log(`\n== 検証: ${ROUTER} × ${RUNS}回 ==`);
let pass = true;
for (let i = 0; i < RUNS; i++) {
  const r = await call(key, ROUTER, QUESTIONS[i]);
  const checks = [
    [r.ok && r.text.length > 0, `200かつ本文非ゼロ（${r.status}・${r.text.length}字${r.error ? `・${r.error}` : ""}）`],
    [Boolean(r.router && r.resolved), `X-Orcaヘッダ（router=${r.router ?? "なし"} resolved=${r.resolved ?? "なし"}）`],
    [r.ms <= base.ms * 3, `レイテンシ ${r.ms}ms ≦ 基準${base.ms}ms×3`],
  ];
  const okAll = checks.every(([c]) => c);
  pass = pass && okAll;
  console.log(` run${i + 1}: ${okAll ? "✅" : "❌"}`);
  for (const [c, label] of checks) console.log(`   ${c ? "○" : "✗"} ${label}`);
}

console.log(
  pass
    ? `\n合格。ROUTING.advice.model を "${ROUTER}" に差し替えてよい（fallbacksは保険で残す）。`
    : `\n不合格。差し替えない。ダッシュボードのルーター設定を確認するか、直接指定のまま提出する。`
);
process.exit(pass ? 0 : 1);
