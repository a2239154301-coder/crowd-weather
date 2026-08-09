/**
 * モデル実測ベンチ — 審査項目⑥（LLMコスト）の一次データを自分で取るためのスクリプト。
 *
 *   node scripts/bench.mjs
 *
 * .env.local の ORCAROUTER_API_KEY を読み、候補モデルに同じプロンプトを投げて
 * レイテンシ・トークン数・解決モデルを表にする。ベンダーの公称値ではなく実測を使う。
 */
import { readFileSync } from "node:fs";

const ORCA_BASE = "https://api.orcarouter.ai/v1";
const TIMEOUT_MS = 60_000;

function loadKey() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("ORCAROUTER_API_KEY="));
  if (!line) throw new Error(".env.local に ORCAROUTER_API_KEY がありません");
  return line.slice("ORCAROUTER_API_KEY=".length).trim();
}

// 実際の advice タスクと同じ形の入力（実測を本番条件に近づける）
const SYSTEM = `あなたはイベント運営のAIアドバイザーです。
CROWD WEATHERの予測データだけを根拠に、日本語で実務的な運営判断を提案してください。
出力は次の4項目だけ、簡潔にしてください。
1. 今すぐやること
2. 30〜60分先に備えること
3. スタッフ配置・導線への提案
4. 注意すべきリスク
数値を引用するときは入力データの値をそのまま使ってください。`;

const FORECAST = {
  hour: 16,
  scope: "会場内",
  weather: "sunny",
  temp: 34,
  tickets: 24000,
  current: {
    maxCrowd: 100,
    maxCrowdZone: "メインステージ",
    maxWBGT: 32.3,
    maxWBGTZone: "物販の列",
    shadeRate: 40,
  },
  dayPlan: {
    peakCrowd: 100,
    peakCrowdHour: 15,
    peakCrowdZone: "メインステージ",
    peakWBGT: 32.3,
    peakWBGTHour: 13,
  },
};

const CANDIDATES = [
  "orcarouter/auto",
  "openai/gpt-4o-mini",
  "openai/gpt-5-mini",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.6-flash",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v4-flash",
];

async function bench(model, apiKey) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ORCA_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `現在のCROWD WEATHERデータ:\n${JSON.stringify(FORECAST, null, 2)}` },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
    });
    const ms = Date.now() - t0;
    const data = await res.json();
    if (!res.ok) {
      return { model, ok: false, ms, note: (data?.error?.message ?? `HTTP ${res.status}`).slice(0, 70) };
    }
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      model,
      ok: true,
      ms,
      resolved: res.headers.get("x-orca-resolved-model") ?? "-",
      inTok: data.usage?.prompt_tokens ?? 0,
      outTok: data.usage?.completion_tokens ?? 0,
      chars: text.length,
      head: text.replace(/\s+/g, " ").slice(0, 40),
    };
  } catch (e) {
    return { model, ok: false, ms: Date.now() - t0, note: e.name === "AbortError" ? "timeout(60s)" : e.message.slice(0, 70) };
  } finally {
    clearTimeout(timer);
  }
}

const apiKey = loadKey();
console.log(`候補 ${CANDIDATES.length} モデルを並列で実測します...\n`);
const results = await Promise.all(CANDIDATES.map((m) => bench(m, apiKey)));

results.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("model", 30) + pad("秒", 8) + pad("in", 7) + pad("out", 7) + pad("字", 6) + "resolved / note");
console.log("-".repeat(105));
for (const r of results) {
  const secs = (r.ms / 1000).toFixed(2);
  if (r.ok) {
    console.log(
      pad(r.model, 30) + pad(secs, 8) + pad(r.inTok, 7) + pad(r.outTok, 7) + pad(r.chars, 6) + (r.resolved !== "-" ? r.resolved : "")
    );
  } else {
    console.log(pad(r.model, 30) + pad(secs, 8) + pad("-", 7) + pad("-", 7) + pad("-", 6) + "❌ " + r.note);
  }
}
console.log("\n出力サンプル（先頭40字）:");
for (const r of results.filter((x) => x.ok)) console.log(`  ${pad(r.model, 30)} ${r.head}`);
