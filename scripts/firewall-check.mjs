/**
 * Agent Firewall の採否ゲート — 「ゲートウェイ側の三層目」をデモの経路に載せてよいかを
 * 実測で決める（router-check.mjs と同じ方針: 検証できたものだけを有効と表記する）。
 *
 * 使い方（2段階）:
 *
 *   1. node scripts/firewall-check.mjs
 *      → ベースライン: tool呼び出し（propose_dispatch）が正常に往復することを確認。
 *        Firewallポリシーを**まだ作っていない/attachしていない**状態でも通るはず
 *
 *   2. ダッシュボード（Firewall画面）で検証用ポリシーを作成:
 *        rule: tool_name = propose_dispatch を **deny**（いったん全拒否）
 *      → node scripts/firewall-check.mjs --expect-deny
 *      → 呼び出しがゲートウェイに遮断されることを確認（enforcementの実在証明）
 *
 *   3. ルールを本命に差し替え:
 *        tool_name = propose_dispatch / args_match_json: toZoneId が
 *        実在18ゾーンID（下のZONE_IDS）に **含まれない** とき deny
 *      → node scripts/firewall-check.mjs（ベースラインが再び通ることを確認）
 *
 * 3まで通ったら、三層目（Firewall）を「検証済み」としてUI・記事に書いてよい。
 * 2で遮断されなければ、Firewallは「設定したが実効未確認」— 08-09のフォールバック
 * 検証と同じ扱いで、有効とは表記しない。
 */
import { readFileSync } from "node:fs";

const ORCA_BASE = "https://api.orcarouter.ai/v1";
const MODEL = "google/gemini-2.5-flash-lite"; // 直接指定（ルーター経由の変数を減らして判定を単純に）
const EXPECT_DENY = process.argv.includes("--expect-deny");

function loadKey() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("ORCAROUTER_API_KEY="));
  if (!line) throw new Error(".env.local に ORCAROUTER_API_KEY がありません");
  return line.slice("ORCAROUTER_API_KEY=".length).trim();
}

const ZONE_IDS = [
  "corr", "wg", "eg", "main", "sub", "shop", "food", "wc", "aid", "exit",
  "plat", "conc", "plaza", "alley", "blvd", "bus", "wgf", "egf",
];

const TOOL = {
  type: "function",
  function: {
    name: "propose_dispatch",
    description: "配置変更の提案を提出する",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              staffName: { type: "string" },
              fromCode: { type: "string" },
              toZoneId: { type: "string", enum: ZONE_IDS },
              action: { type: "string" },
              urgency: { type: "string", enum: ["now", "soon"] },
              reason: { type: "string" },
            },
            required: ["staffName", "fromCode", "toZoneId", "action", "urgency", "reason"],
          },
        },
        note: { type: "string" },
      },
      required: ["proposals", "note"],
    },
  },
};

const key = loadKey();
const t0 = Date.now();
const res = await fetch(`${ORCA_BASE}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: "配置提案アシスタント。propose_dispatchツールで提案する。" },
      {
        role: "user",
        content:
          "西ゲート(wg)の観測が混雑100。A-1の鈴木(誘導)が現地にいる。列整理の提案を1件出して。",
      },
    ],
    tools: [TOOL],
    tool_choice: { type: "function", function: { name: "propose_dispatch" } },
    temperature: 0.2,
    max_tokens: 600,
  }),
});
const ms = Date.now() - t0;
const data = await res.json().catch(() => ({}));
const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
const blocked =
  !res.ok &&
  /firewall/i.test(JSON.stringify(data?.error ?? {}));

console.log(`HTTP ${res.status} / ${ms}ms`);

if (EXPECT_DENY) {
  if (blocked) {
    console.log(`✅ 遮断を確認: ${data?.error?.message ?? "(firewall_blocked)"}`);
    console.log("→ enforcementは実在する。ルールを本命（args_match_json）に差し替えて手順3へ");
    process.exit(0);
  }
  console.log(
    toolCall
      ? `❌ 遮断されずtool呼び出しが返った（args: ${String(toolCall.function?.arguments).slice(0, 120)}…）`
      : `❌ 遮断でもtool応答でもない: ${JSON.stringify(data).slice(0, 200)}`
  );
  console.log("→ ポリシーのattach先キー・enable状態・tool_nameの綴りを確認");
  process.exit(1);
}

// ベースライン
if (res.ok && toolCall?.function?.arguments) {
  let ok = false;
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    ok = Array.isArray(parsed.proposals);
    const zones = (parsed.proposals ?? []).map((p) => p.toZoneId);
    const invalid = zones.filter((z) => !ZONE_IDS.includes(z));
    console.log(`✅ tool呼び出し正常（提案${parsed.proposals?.length ?? 0}件・zone=${zones.join(",")}）`);
    if (invalid.length) console.log(`⚠ enum外のzoneが混入: ${invalid.join(",")}（サーバー側検証が落とす）`);
  } catch {
    console.log("❌ argumentsがJSONとして解釈できない");
  }
  process.exit(ok ? 0 : 1);
}
console.log(`❌ tool呼び出しが返らない: ${JSON.stringify(data).slice(0, 300)}`);
if (blocked) console.log("（Firewallに遮断されている。--expect-deny での実行か、ルールの見直しを）");
process.exit(1);
