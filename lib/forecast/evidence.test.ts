import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SOURCES,
  INDEX100_PERSONS_PER_SQM,
  LOS_PLAIN,
  evidenceLabel,
  evidencePlain,
  losBand,
  personsPerSqm,
} from "./evidence";
import type { ZoneKind } from "./types";

/**
 * 較正層の仕様固定。
 *
 * ここで守りたいのは「アプリ内の危険帯閾値75が物理的に意味を持つこと」。
 * 較正定数を動かすと75の物理的な位置（ジャム密度帯・LOS E/F境界帯）が
 * ズレる＝根拠セクションの主張が嘘になる。だから範囲テストで釘を打つ。
 */

/** 滞留系（較正定数5.5の3種）。屋内系indoor/aidは含まない点に注意 */
const STANDING: ZoneKind[] = ["queue", "gate", "stage"];
/** 通路系（歩行路LOSを適用する3種） */
const WALKWAY: ZoneKind[] = ["corridor", "station", "alley"];
const ALL_KINDS: ZoneKind[] = [
  "stage",
  "indoor",
  "gate",
  "corridor",
  "queue",
  "aid",
  "station",
  "alley",
];

const LOS_ORDER = ["A", "B", "C", "D", "E", "F"] as const;
const losOrdinal = (los: string) => LOS_ORDER.indexOf(los as (typeof LOS_ORDER)[number]);

describe("personsPerSqm — 危険帯閾値75の物理的整合", () => {
  it("滞留系（queue/gate/stage）の75は3.5〜4.7人/m²（Stillジャム密度4人/m²の帯）", () => {
    for (const kind of STANDING) {
      const p = personsPerSqm(kind, 75);
      expect(p).toBeGreaterThanOrEqual(3.5);
      expect(p).toBeLessThanOrEqual(4.7); // 4.7 = グリーンガイドの立見安全上限
    }
  });

  it("通路系（corridor/station/alley）の75は1.5〜2.2人/m²（Fruin LOS E/F境界1.79の帯）", () => {
    for (const kind of WALKWAY) {
      const p = personsPerSqm(kind, 75);
      expect(p).toBeGreaterThanOrEqual(1.5);
      expect(p).toBeLessThanOrEqual(2.2);
    }
  });

  it("定義どおり index/100 × 較正定数の線形（丸め・クランプなし）", () => {
    for (const kind of ALL_KINDS) {
      expect(personsPerSqm(kind, 0)).toBe(0);
      expect(personsPerSqm(kind, 100)).toBe(INDEX100_PERSONS_PER_SQM[kind]);
      expect(personsPerSqm(kind, 50)).toBeCloseTo(INDEX100_PERSONS_PER_SQM[kind] / 2, 10);
    }
  });
});

describe("losBand — 指数75がLOS最悪帯に入る", () => {
  it("滞留系 index=75 は LOS E または F", () => {
    for (const kind of STANDING) {
      const { los } = losBand(kind, personsPerSqm(kind, 75));
      expect(["E", "F"]).toContain(los);
    }
  });

  it("通路系 index=75 は LOS F（歩行流の崩壊域）", () => {
    for (const kind of WALKWAY) {
      const { los } = losBand(kind, personsPerSqm(kind, 75));
      expect(los).toBe("F");
    }
  });
});

describe("losBand — 境界値（境界ちょうどは下側の帯）", () => {
  it("歩行路LOSの境界: 0.083/0.27/0.45/0.72/1.79", () => {
    expect(losBand("corridor", 0.083).los).toBe("A");
    expect(losBand("corridor", 0.084).los).toBe("B");
    expect(losBand("corridor", 0.27).los).toBe("B");
    expect(losBand("corridor", 0.28).los).toBe("C");
    expect(losBand("corridor", 0.45).los).toBe("C");
    expect(losBand("corridor", 0.46).los).toBe("D");
    expect(losBand("corridor", 0.72).los).toBe("D");
    expect(losBand("corridor", 0.73).los).toBe("E");
    expect(losBand("corridor", 1.79).los).toBe("E");
    expect(losBand("corridor", 1.8).los).toBe("F");
  });

  it("待機列LOSの境界: 0.83/1.11/2.0/3.0/4.0", () => {
    expect(losBand("queue", 0.83).los).toBe("A");
    expect(losBand("queue", 0.84).los).toBe("B");
    expect(losBand("queue", 1.11).los).toBe("B");
    expect(losBand("queue", 1.12).los).toBe("C");
    expect(losBand("queue", 2.0).los).toBe("C");
    expect(losBand("queue", 2.1).los).toBe("D");
    expect(losBand("queue", 3.0).los).toBe("D");
    expect(losBand("queue", 3.1).los).toBe("E");
    expect(losBand("queue", 4.0).los).toBe("E");
    expect(losBand("queue", 4.1).los).toBe("F");
  });

  it("単調性: 密度を上げてもLOSが後退しない（全ゾーン種別・0〜8人/m²掃引）", () => {
    for (const kind of ALL_KINDS) {
      let prev = -1;
      for (let i = 0; i <= 800; i++) {
        const ord = losOrdinal(losBand(kind, i / 100).los);
        expect(ord).toBeGreaterThanOrEqual(prev);
        prev = ord;
      }
    }
  });
});

describe("losBand — 確認度タグ", () => {
  it("通路系は全帯が二次資料（B/C境界に資料間の食い違いがあるため）", () => {
    for (const kind of WALKWAY) {
      for (const ppsm of [0.05, 0.2, 0.4, 0.6, 1.5, 3.0]) {
        expect(losBand(kind, ppsm).confidence).toBe("二次資料");
      }
    }
  });

  it("滞留系はA/B=二次資料・C/D=推定・E/F=二次資料", () => {
    // C/DはFruin原典の待機列数値が今回未確認 → 正直に「推定」で出す
    const expected: [number, string, string][] = [
      [0.5, "A", "二次資料"],
      [1.0, "B", "二次資料"],
      [1.5, "C", "推定"],
      [2.5, "D", "推定"],
      [3.5, "E", "二次資料"],
      [5.0, "F", "二次資料"],
    ];
    for (const [ppsm, los, confidence] of expected) {
      const r = losBand("queue", ppsm);
      expect(r.los).toBe(los);
      expect(r.confidence).toBe(confidence);
    }
  });
});

describe("evidenceLabel — 表示フォーマット", () => {
  it("小数1桁＋LOS帯を「相当」付きで出す", () => {
    // queue@75 = 4.125（浮動小数で正確に表現できる値）→ "4.1"
    expect(evidenceLabel("queue", 75)).toBe("≈4.1人/m²・LOS F相当");
    expect(evidenceLabel("corridor", 100)).toBe("≈2.7人/m²・LOS F相当");
  });

  it("全ゾーン種別・複数指数でフォーマットが崩れない", () => {
    for (const kind of ALL_KINDS) {
      for (const index of [0, 30, 75, 100]) {
        expect(evidenceLabel(kind, index)).toMatch(/^≈\d+\.\d人\/m²・LOS [A-F]相当$/);
      }
    }
  });
});

describe("EVIDENCE_SOURCES — 出典一覧", () => {
  it("6件ある", () => {
    expect(EVIDENCE_SOURCES).toHaveLength(6);
  });

  it("明石歩道橋の行は原本未確認であることを明記している", () => {
    const akashi = EVIDENCE_SOURCES.find((s) => s.claim.includes("明石"));
    expect(akashi).toBeDefined();
    expect(`${akashi!.source}${akashi!.value}${akashi!.claim}`).toMatch(/未確認/);
  });

  it("一次確認済みは警察庁通達の1件だけ（それ以外を一次と偽らない）", () => {
    const primary = EVIDENCE_SOURCES.filter((s) => s.confidence === "一次確認済み");
    expect(primary).toHaveLength(1);
    expect(primary[0].claim).toMatch(/警察庁/);
    expect(primary[0].claim).toMatch(/数値基準を含まない/);
  });

  it("主要な出典（Fruin・Still・Helbing・グリーンガイド）が揃っている", () => {
    const all = EVIDENCE_SOURCES.map((s) => s.source).join(" ");
    expect(all).toMatch(/Fruin/);
    expect(all).toMatch(/Still/);
    expect(all).toMatch(/Helbing/);
    expect(all).toMatch(/Guide to Safety at Sports Grounds/);
  });
});

describe("evidencePlain — 平易表示（08-13 追加。evidenceLabel は不変更）", () => {
  const KINDS: ZoneKind[] = ["queue", "gate", "stage", "indoor", "aid", "corridor", "station", "alley"];

  it("全kind×代表指数でフォーマットが崩れない", () => {
    for (const kind of KINDS) {
      for (const index of [0, 25, 50, 75, 100]) {
        expect(evidencePlain(kind, index)).toMatch(/^1m²あたり約\d+\.\d人 — .+$/);
      }
    }
  });

  it("evidenceLabel と同じ計算に基づく（人数・LOS帯が一致）", () => {
    for (const kind of KINDS) {
      for (const index of [30, 75, 90]) {
        const ppsm = personsPerSqm(kind, index).toFixed(1);
        const { los } = losBand(kind, personsPerSqm(kind, index));
        expect(evidencePlain(kind, index)).toBe(`1m²あたり約${ppsm}人 — ${LOS_PLAIN[los]}`);
        expect(evidenceLabel(kind, index)).toContain(`LOS ${los}相当`);
      }
    }
  });

  it("危険帯75の滞留系は「身動きがとりづらい」= LOS F の平易語になる", () => {
    expect(evidencePlain("queue", 75)).toContain("身動きがとりづらい");
    expect(LOS_PLAIN.F).toBe("身動きがとりづらい");
  });
});
