import { describe, expect, it } from "vitest";
import { normalizeIngested, VENUE_CANVAS, type IngestedVenue } from "./ingest-schema";

/**
 * AI出力の検証・正規化層のテスト。
 * 「AIの出力をそのまま信用しない」がこの製品の安全設計 — その関門の仕様を固定する。
 */

const base: IngestedVenue = {
  name: "テスト会場",
  northDeg: 0,
  confidence: "high",
  notes: "",
  zones: [
    {
      id: "a",
      name: "観客エリア",
      kind: "stage",
      base: 0.9,
      roofed: false,
      shape: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 300, y: 300 },
        { x: 100, y: 300 },
      ],
    },
  ],
  buildings: [],
};

describe("normalizeIngested", () => {
  it("正常な入力はそのまま通る", () => {
    const { venue, issues } = normalizeIngested(base);
    expect(venue.zones).toHaveLength(1);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("キャンバス外の座標はクランプされる", () => {
    const { venue } = normalizeIngested({
      ...base,
      zones: [
        {
          ...base.zones[0],
          shape: [
            { x: -50, y: -50 },
            { x: 99999, y: 0 },
            { x: 500, y: 99999 },
          ],
        },
      ],
    });
    for (const p of venue.zones[0].shape) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(VENUE_CANVAS.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(VENUE_CANVAS.height);
    }
  });

  it("頂点が3未満のゾーンは除外され、errorとして報告される", () => {
    const { venue, issues } = normalizeIngested({
      ...base,
      zones: [
        { ...base.zones[0], shape: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
      ],
    });
    expect(venue.zones).toHaveLength(0);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });

  it("高さ不明の構造物は12mを仮置きして警告する", () => {
    const { venue, issues } = normalizeIngested({
      ...base,
      buildings: [
        {
          id: "b1",
          name: "謎の構造物",
          height: Number.NaN,
          shape: base.zones[0].shape,
        },
      ],
    });
    expect(venue.buildings[0].height).toBe(12);
    expect(issues.some((i) => i.message.includes("高さ"))).toBe(true);
  });

  it("ゾーンゼロはエラーになる（別の資料を促す）", () => {
    const { issues } = normalizeIngested({ ...base, zones: [] });
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
});
