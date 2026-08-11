/**
 * 優先01の技術検証 — 会場写真から Venue JSON が取れるかを確かめる。
 *
 *   node scripts/probe-ingest.mjs
 *
 * UIを作る前にこれを通す。ここが通らなければ設計が変わるため。
 * 確かめたいことは3つ:
 *   1. OrcaRouter 経由で Vision（画像入力）が通るか
 *   2. Structured Outputs（json_schema）で Venue 型を強制できるか
 *   3. 返ってきた多角形が、実際に地図として成立する座標か
 */
import { readFileSync } from "node:fs";

const ORCA_BASE = "https://api.orcarouter.ai/v1";
const TIMEOUT_MS = 120_000;

function loadKey() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("ORCAROUTER_API_KEY="));
  if (!line) throw new Error(".env.local に ORCAROUTER_API_KEY がありません");
  return line.slice("ORCAROUTER_API_KEY=".length).trim();
}

const W = 1000;
const H = 700;

// Venue 型のうち、AIに埋めさせる部分だけを schema にする。
// open/close/width/height はアプリ側で決めるのでAIには出させない。
const VENUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "会場の名称。写真から読み取れなければ「特設会場」等の一般名" },
    northDeg: {
      type: "number",
      description: "画像上で北がどちらを向くか（0=画像上方向、90=右、180=下、270=左）。判断できなければ0",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "読み取り全体の確信度",
    },
    notes: { type: "string", description: "読み取れなかったもの・人が補正すべき点を日本語で" },
    zones: {
      type: "array",
      description: "来場者が滞留・移動する領域",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "英小文字の短いID" },
          name: { type: "string", description: "日本語の名称" },
          kind: {
            type: "string",
            enum: ["stage", "indoor", "gate", "corridor", "queue", "aid", "station", "alley"],
          },
          base: { type: "number", description: "混みやすさ係数 0.3〜1.0" },
          roofed: { type: "boolean", description: "屋根の下にあるか" },
          shape: {
            type: "array",
            description: `多角形の頂点。3〜8個。座標は左上原点で x:0-${W}, y:0-${H}`,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          },
        },
        required: ["id", "name", "kind", "base", "roofed", "shape"],
      },
    },
    buildings: {
      type: "array",
      description: "影を落とす構造物。建物・仮設ステージの屋根・タワーなど",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          height: { type: "number", description: "推定の高さ(m)。用途から推定してよい" },
          shape: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          },
        },
        required: ["id", "name", "height", "shape"],
      },
    },
  },
  required: ["name", "northDeg", "confidence", "notes", "zones", "buildings"],
};

const SYSTEM = `あなたはイベント会場の資料（航空写真・会場図面・平面図）を読み取り、
雑踏警備の計画に使える構造化データに変換する専門家です。

読み取りの原則:
- 座標は必ず左上を原点とし、x は 0〜${W}、y は 0〜${H} の範囲に正規化すること。
  画像の縦横比に関わらず、画像全体がこの矩形に収まるものとして換算する。
- zones は「人が滞留する場所・並ぶ場所・通る場所」を取る。観客エリア、待機列、
  飲食エリア、トイレ列、救護・給水、ゲート、通路など。
- buildings は「影を落とす構造物」を取る。ステージの屋根、テント、タワー、
  周辺の建物など。高さは用途から推定してよい（仮設テント3m、ステージ屋根12m、
  PAタワー8m、中層ビル30m など）。
- 多角形は実際の形に沿わせる。長方形で済むものは4点でよいが、
  斜めの領域は斜めのまま取ること。
- 写真から読み取れないもの（実寸・縮尺・正確な方位・建物の正確な高さ）は
  推測でよいが、notes に「人が補正すべき」と明記すること。
- 確信が持てない領域を無理に作らない。確実なものだけを返す。`;

async function main() {
  const apiKey = loadKey();
  const b64 = readFileSync(new URL("../public/samples/venue-sample-1024.png", import.meta.url)).toString("base64");

  const models = process.argv[2] ? [process.argv[2]] : ["google/gemini-2.5-pro", "openai/gpt-4o"];

  for (const model of models) {
    console.log(`\n${"=".repeat(70)}\nモデル: ${model}\n${"=".repeat(70)}`);
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
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "この会場写真から、雑踏警備の予報に使うゾーンと構造物を読み取ってJSONにしてください。",
                },
                { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 8000,
          response_format: {
            type: "json_schema",
            json_schema: { name: "venue", strict: true, schema: VENUE_SCHEMA },
          },
        }),
      });

      const ms = Date.now() - t0;
      const data = await res.json();
      if (!res.ok) {
        console.log(`❌ HTTP ${res.status} (${(ms / 1000).toFixed(1)}s)`);
        console.log("   ", JSON.stringify(data).slice(0, 400));
        continue;
      }

      const text = data.choices?.[0]?.message?.content ?? "";
      console.log(`✅ HTTP 200  ${(ms / 1000).toFixed(1)}秒  in ${data.usage?.prompt_tokens} / out ${data.usage?.completion_tokens} tok`);
      console.log(`   本文 ${text.length} 字`);

      let venue;
      try {
        venue = JSON.parse(text);
      } catch (e) {
        console.log("❌ JSONパース失敗:", e.message);
        console.log("   先頭300字:", text.slice(0, 300));
        continue;
      }

      // ── 品質チェック
      console.log(`\n  会場名: ${venue.name}`);
      console.log(`  確信度: ${venue.confidence} / 北の向き: ${venue.northDeg}°`);
      console.log(`  zones: ${venue.zones?.length ?? 0} 件 / buildings: ${venue.buildings?.length ?? 0} 件`);

      const problems = [];
      const inRange = (p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
      for (const z of venue.zones ?? []) {
        if (!z.shape || z.shape.length < 3) problems.push(`${z.name}: 頂点${z.shape?.length ?? 0}個（3未満）`);
        else if (!z.shape.every(inRange)) problems.push(`${z.name}: 座標が範囲外`);
        else if (polyArea(z.shape) < 200) problems.push(`${z.name}: 面積が極小 (${polyArea(z.shape).toFixed(0)})`);
      }
      for (const b of venue.buildings ?? []) {
        if (!b.shape || b.shape.length < 3) problems.push(`建物 ${b.name}: 頂点不足`);
        else if (!b.shape.every(inRange)) problems.push(`建物 ${b.name}: 座標が範囲外`);
        if (!(b.height > 0)) problems.push(`建物 ${b.name}: 高さ不正 (${b.height})`);
      }

      console.log(`\n  ゾーン一覧:`);
      for (const z of venue.zones ?? []) {
        console.log(
          `    ${z.kind.padEnd(9)} ${z.name.padEnd(14)} base=${z.base} roofed=${z.roofed ? "○" : "×"} 頂点${z.shape?.length} 面積${polyArea(z.shape || []).toFixed(0)}`
        );
      }
      console.log(`  構造物一覧:`);
      for (const b of venue.buildings ?? []) {
        console.log(`    ${b.name.padEnd(16)} ${b.height}m 頂点${b.shape?.length}`);
      }

      console.log(`\n  読み取りメモ: ${venue.notes}`);
      console.log(`\n  品質: ${problems.length === 0 ? "✅ 問題なし" : `⚠️ ${problems.length}件`}`);
      for (const p of problems) console.log(`    - ${p}`);

      // 目視確認用に最初のモデルの結果を保存する
      if (model === models[0]) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(new URL("../.probe-venue.json", import.meta.url), JSON.stringify(venue, null, 2));
        console.log("\n  → .probe-venue.json に保存（probe-render.mjs で重ね描き確認）");
      }
    } catch (e) {
      console.log(`❌ ${e.name === "AbortError" ? "タイムアウト(120s)" : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(a / 2);
}

await main();
