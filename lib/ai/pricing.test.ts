import { describe, expect, it } from "vitest";
import {
  EVENT_PROFILE,
  PRICES,
  USD_JPY,
  costYen,
  costYenForMeta,
  estimateEventCost,
  formatYen,
} from "./pricing";

/**
 * 原価換算の仕様固定。
 * いちばん守りたいのは「ROUTING に単価漏れのモデルが入ると落ちる」こと。
 * 単価が引けないモデルで課金が始まると、画面の原価表示が黙って「—」になる。
 */

describe("costYen", () => {
  it("既知の usage を円に換算する", () => {
    // gemini-2.5-flash-lite: in $0.1/M, out $0.4/M
    const yen = costYen("google/gemini-2.5-flash-lite", {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(yen).toBeCloseTo((0.1 + 0.4) * USD_JPY, 6);
  });

  it("実運用スケール（advice 1回 ≈ in800/out350）は1円未満", () => {
    const yen = costYen("google/gemini-2.5-flash-lite", {
      prompt_tokens: 800,
      completion_tokens: 350,
      total_tokens: 1150,
    })!;
    expect(yen).toBeGreaterThan(0);
    expect(yen).toBeLessThan(1);
  });

  it("未知のモデルは null（誤った数字を出さない）", () => {
    expect(
      costYen("unknown/model", { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 })
    ).toBeNull();
  });

  it("usage が null なら null", () => {
    expect(costYen("openai/gpt-4.1", null)).toBeNull();
  });
});

describe("costYenForMeta — 名前付きルーター対応", () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 };

  it("直接指定なら servedModel の単価", () => {
    expect(costYenForMeta({ servedModel: "openai/gpt-4.1", resolvedModel: null, usage })).toBeCloseTo(
      2.0 * USD_JPY,
      6
    );
  });

  it("orcarouter/ 経由なら resolvedModel の単価で計算する", () => {
    expect(
      costYenForMeta({
        servedModel: "orcarouter/cw-advice",
        resolvedModel: "google/gemini-2.5-flash-lite",
        usage,
      })
    ).toBeCloseTo(0.1 * USD_JPY, 6);
  });

  it("ルーター経由で resolvedModel が取れなければ null", () => {
    expect(
      costYenForMeta({ servedModel: "orcarouter/cw-advice", resolvedModel: null, usage })
    ).toBeNull();
  });
});

describe("PRICES — ROUTING との同期", () => {
  it("ROUTING の全チェーン（primary + fallbacks）に単価がある", async () => {
    // orca.ts の ROUTING は非export なので、ソースを読んでモデルIDを抽出する。
    // レーン追加時に単価を書き忘れると、ここで落ちて気づける
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./orca.ts", import.meta.url), "utf8");
    const ids = [...src.matchAll(/"((?:openai|anthropic|google|deepseek|qwen|grok|kimi|minimax|z-ai)\/[a-z0-9.\-]+)"/g)]
      .map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(7);
    for (const id of new Set(ids)) {
      expect(PRICES[id], `PRICES に ${id} の単価がありません（pricing.ts に追記すること）`).toBeDefined();
    }
  });
});

describe("estimateEventCost — 1イベントの原価試算", () => {
  it("4レーンすべてを含む", () => {
    const tasks = new Set(EVENT_PROFILE.map((r) => r.task));
    expect(tasks).toEqual(new Set(["ingest", "plan", "advice", "whatif"]));
  });

  it("合計は行の合計と一致し、正の値", () => {
    const { rows, totalYen } = estimateEventCost();
    expect(totalYen).toBeCloseTo(rows.reduce((a, r) => a + r.yen, 0), 6);
    expect(totalYen).toBeGreaterThan(0);
  });

  it("1イベントの原価は3,000円クレジットに対して十分小さい（<100円）", () => {
    // ここが崩れたらプロファイルか単価の桁を間違えている
    expect(estimateEventCost().totalYen).toBeLessThan(100);
  });
});

describe("formatYen", () => {
  it("1円未満は小数2桁・以上は1桁・nullは —", () => {
    expect(formatYen(0.31)).toBe("¥0.31");
    expect(formatYen(12.34)).toBe("¥12.3");
    expect(formatYen(null)).toBe("—");
  });
});
