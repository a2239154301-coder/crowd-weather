import { describe, expect, it } from "vitest";
import type { Observation } from "./nowcast";
import { SOURCE_WEIGHT, correctedDensity, correctionFactor, fuseObservations } from "./nowcast";

/**
 * 観測統合（ナウキャスト）層の仕様固定。
 *
 * ここで守りたいのは3つ。
 * 1. 信頼度の序列（カメラ > ボタン > 自由文 > 写真）が結果に実際に効くこと
 * 2. 食い違い時は平均でならさず**高い方**を出すこと（安全側。見落としの方が致命的）
 * 3. 観測が古くなるほど予報に回帰すること（3時間で完全回帰）
 *
 * 数値は手計算で固定する。実装の丸め方や重みが変わればここで落ちる。
 */

/** 観測を1行で作る補助。デフォルトはカメラ・現在時刻 */
const ob = (
  impliedDensity: number,
  minutes: number,
  source: Observation["source"] = "camera",
  zoneId = "gate"
): Observation => ({ zoneId, minutes, impliedDensity, source });

const NOW = 600; // 10:00

describe("fuseObservations — 信頼度重み", () => {
  it("同時刻・同値の逸脱でも、重いソースほど加重平均を強く引く（序列そのもの）", () => {
    // アンカー: カメラ=50（重み1.0固定）。そこに各ソースが70を主張したときの統合値。
    // 差20 < 25 なので conflict にはならず加重平均になる。
    // (50×1.0 + 70×w) / (1.0 + w) は w について単調増加なので、序列がそのまま数字に出る
    const fusedWith = (source: Observation["source"]) =>
      fuseObservations([ob(50, NOW, "camera"), ob(70, NOW, source)], "gate", NOW).fusedDensity!;

    expect(fusedWith("camera")).toBe(60); // (50+70)/2
    expect(fusedWith("staff-button")).toBe(59); // 106/1.8 = 58.9
    expect(fusedWith("staff-text")).toBe(58); // 92/1.6 = 57.5
    expect(fusedWith("photo")).toBe(57); // 85/1.5 = 56.7
  });

  it("同じ値の組でも、カメラが高い値を持つ方が統合値は高い（カメラ側に寄る）", () => {
    const cameraHigh = fuseObservations(
      [ob(70, NOW, "camera"), ob(50, NOW, "photo")],
      "gate",
      NOW
    );
    const photoHigh = fuseObservations([ob(50, NOW, "camera"), ob(70, NOW, "photo")], "gate", NOW);
    expect(cameraHigh.fusedDensity).toBe(63); // (70×1.0 + 50×0.5)/1.5 = 63.3
    expect(photoHigh.fusedDensity).toBe(57); // (50×1.0 + 70×0.5)/1.5 = 56.7
    expect(cameraHigh.fusedDensity!).toBeGreaterThan(photoHigh.fusedDensity!);
  });

  it("SOURCE_WEIGHT の序列が崩れていない（定数の退化防止）", () => {
    expect(SOURCE_WEIGHT.camera).toBeGreaterThan(SOURCE_WEIGHT["staff-button"]);
    expect(SOURCE_WEIGHT["staff-button"]).toBeGreaterThan(SOURCE_WEIGHT["staff-text"]);
    expect(SOURCE_WEIGHT["staff-text"]).toBeGreaterThan(SOURCE_WEIGHT.photo);
  });
});

describe("fuseObservations — 鮮度", () => {
  it("同じソースでも新しい観測の方が強く効く", () => {
    // カメラ40（いま・重み1.0）とカメラ60（90分前・重み0.5）。差20 < 25。
    // (40×1.0 + 60×0.5)/1.5 = 46.7 → 単純平均の50より新しい40側に寄る
    const f = fuseObservations([ob(40, NOW), ob(60, NOW - 90)], "gate", NOW);
    expect(f.fusedDensity).toBe(47);
  });

  it("180分より古い観測と未来の観測は採用しない", () => {
    const f = fuseObservations(
      [
        ob(90, NOW - 181), // 181分前 → 対象外
        ob(90, NOW + 1), // 未来（時刻の打ち間違い）→ 対象外
        ob(40, NOW - 10), // これだけ採用
      ],
      "gate",
      NOW
    );
    expect(f.usedCount).toBe(1);
    expect(f.fusedDensity).toBe(40);
    expect(f.latestMinutes).toBe(NOW - 10);
  });

  it("ちょうど180分前は採用し、値は安全側（最大値）で出す", () => {
    // age=180 は重みが0になり加重平均が作れない唯一のケース。
    // NaN を出さず conflict 時と同じ最大値に倒す仕様をここで固定する
    // （この鮮度では correctionFactor が 1 を返すので、下流の補正にはほぼ効かない）
    const f = fuseObservations([ob(72, NOW - 180)], "gate", NOW);
    expect(f.fusedDensity).toBe(72);
    expect(f.usedCount).toBe(1);
    expect(f.conflict).toBe(false);
  });
});

describe("fuseObservations — 食い違い（conflict）", () => {
  it("カメラ=60とスタッフ=90が同時に来たら、高い方の90を信じてフラグを立てる", () => {
    // 平均の75は両方の顔を立ててどちらの現実にも合わない。
    // 安全側に倒し、確認（無線）は人がやる——この設計の要
    const f = fuseObservations([ob(60, NOW, "camera"), ob(90, NOW, "staff-button")], "gate", NOW);
    expect(f.conflict).toBe(true);
    expect(f.fusedDensity).toBe(90);
    expect(f.usedCount).toBe(2);
  });

  it("開き25ちょうどで conflict、24なら加重平均のまま", () => {
    const at25 = fuseObservations([ob(50, NOW, "camera"), ob(75, NOW, "staff-button")], "gate", NOW);
    expect(at25.conflict).toBe(true);
    expect(at25.fusedDensity).toBe(75);

    const at24 = fuseObservations([ob(50, NOW, "camera"), ob(74, NOW, "staff-button")], "gate", NOW);
    expect(at24.conflict).toBe(false);
    expect(at24.fusedDensity).toBe(61); // (50×1.0 + 74×0.8)/1.8 = 60.7
  });
});

describe("fuseObservations — 採用範囲とメタ情報", () => {
  it("観測が無ければ fusedDensity は null（0ではない。0は「空いている」の意味を持つ）", () => {
    const empty = fuseObservations([], "gate", NOW);
    expect(empty).toEqual({
      zoneId: "gate",
      fusedDensity: null,
      conflict: false,
      usedCount: 0,
      latestMinutes: null,
    });
  });

  it("別ゾーンの観測は混ぜない", () => {
    const f = fuseObservations([ob(90, NOW, "camera", "stage")], "gate", NOW);
    expect(f.fusedDensity).toBeNull();
    expect(f.usedCount).toBe(0);
  });

  it("latestMinutes は採用観測の最新時刻（配列の順序に依らない）", () => {
    const f = fuseObservations([ob(50, NOW - 60), ob(52, NOW - 20), ob(48, NOW - 40)], "gate", NOW);
    expect(f.latestMinutes).toBe(NOW - 20);
    expect(f.usedCount).toBe(3);
  });
});

describe("correctionFactor — 予報への補正率", () => {
  it("観測なし・予測0以下では補正しない（factor = 1）", () => {
    expect(correctionFactor(null, 50, 0)).toBe(1);
    expect(correctionFactor(80, 0, 0)).toBe(1);
    expect(correctionFactor(80, -5, 0)).toBe(1);
  });

  it("比率は 0.5〜2.0 にクランプする（観測1点で予報を全否定させない）", () => {
    expect(correctionFactor(100, 10, 0)).toBe(2.0); // 生の比は10倍
    expect(correctionFactor(10, 100, 0)).toBe(0.5); // 生の比は0.1倍
    expect(correctionFactor(60, 40, 0)).toBe(1.5); // クランプ内はそのまま
  });

  it("古い観測ほど 1 に近づき、180分以降は完全に予報へ回帰する", () => {
    // raw=2.0 の観測を時間だけ変える。1からの距離が単調に縮むこと
    const ages = [0, 30, 60, 90, 120, 150, 180, 240];
    const factors = ages.map((a) => correctionFactor(80, 40, a));
    for (let i = 1; i < factors.length; i++) {
      expect(Math.abs(factors[i] - 1)).toBeLessThanOrEqual(Math.abs(factors[i - 1] - 1));
    }
    expect(factors[ages.indexOf(180)]).toBe(1);
    expect(factors[ages.indexOf(240)]).toBe(1); // 180分超も 1 のまま（負に反転しない）
  });

  it("減衰の途中の値が線形の定義どおり（上振れ・下振れの両側）", () => {
    // 2進数で正確に表せる age を選び toBe で固定する（浮動小数のフレーク防止）
    expect(correctionFactor(80, 40, 45)).toBe(1.75); // raw=2.0, 減衰0.75
    expect(correctionFactor(80, 40, 90)).toBe(1.5); // raw=2.0, 減衰0.5
    expect(correctionFactor(30, 60, 90)).toBe(0.75); // raw=0.5, 減衰0.5
  });
});

describe("correctedDensity — 定義域", () => {
  it("0〜100 にクランプし、Math.round で丸める", () => {
    expect(correctedDensity(60, 2.0)).toBe(100); // 120 → 100
    expect(correctedDensity(33, 1.5)).toBe(50); // 49.5 → 50
    expect(correctedDensity(10, 0.5)).toBe(5);
    expect(correctedDensity(10, 0)).toBe(0);
    expect(correctedDensity(0, 2.0)).toBe(0);
    expect(correctedDensity(57, 1)).toBe(57);
  });
});

describe("決定性", () => {
  it("同じ入力なら同じ出力。入力配列も破壊しない", () => {
    const obs = [
      ob(40, NOW - 10, "camera"),
      ob(55, NOW - 30, "staff-button"),
      ob(50, NOW - 60, "photo"),
    ];
    const snapshot = structuredClone(obs);
    const a = fuseObservations(obs, "gate", NOW);
    const b = fuseObservations(obs, "gate", NOW);
    expect(a).toEqual(b);
    expect(obs).toEqual(snapshot); // 並べ替え・書き換えをしていない
    expect(correctionFactor(a.fusedDensity, 48, NOW - a.latestMinutes!)).toBe(
      correctionFactor(b.fusedDensity, 48, NOW - b.latestMinutes!)
    );
  });
});
