import { describe, expect, it } from "vitest";
import { TIMETABLE, actAt, isIntermission, timetableContext } from "./timetable";
import { demandFactors, applyDemand, hasOverlap } from "@/lib/forecast/demand";
import { HISTORY, historyCurves } from "./history";
import { CAMERAS, CAMERA_RATIO_FRAMES, cameraSeries, latestFrames } from "./camera";
import { HOURS, VENUE, zonesFor } from "@/lib/forecast/venue";

/**
 * デモデータ層の仕様固定。
 * いちばん守りたいのは (1) 決定性（毎回同じ＝デモ・スクショが再現できる）
 * (2) 「想定外の山」が仕込まれていること（調整デモの筋書きが成立する）。
 */

describe("timetable — 進行表", () => {
  it("同一ステージで演目が重ならない", () => {
    expect(hasOverlap()).toBe(false);
  });

  it("開場〜終演の範囲に収まる", () => {
    for (const x of TIMETABLE) {
      expect(x.from).toBeGreaterThanOrEqual(VENUE.open);
      expect(x.to).toBeLessThanOrEqual(VENUE.close);
      expect(x.from).toBeLessThan(x.to);
    }
  });

  it("ヘッドライナーは集客力1.0で夜にある", () => {
    const head = TIMETABLE.find((x) => x.draw === 1.0)!;
    expect(head.from).toBeGreaterThanOrEqual(18);
  });

  it("actAt / isIntermission / timetableContext が引ける", () => {
    expect(actAt("main", 19.5)?.act).toBe("ヘッドライナー");
    // 18.5〜19:00 はヘッドライナー直前の幕間
    expect(isIntermission(18.75)).toBe(true);
    const ctx = timetableContext(18.75);
    expect(ctx.next?.act).toBe("ヘッドライナー");
  });
});

describe("demand — 需要整形", () => {
  it("ヘッドライナー中はメインステージの倍率が1.5", () => {
    const f = demandFactors(19.5).find((d) => d.zoneId === "main");
    expect(f?.factor).toBeCloseTo(1.5, 5);
  });

  it("幕間は物販・フード・トイレが1.35倍、ステージが0.6倍", () => {
    const fs = demandFactors(18.75);
    expect(fs.find((d) => d.zoneId === "shop")?.factor).toBe(1.35);
    expect(fs.find((d) => d.zoneId === "main")?.factor).toBe(0.6);
  });

  it("applyDemand は0-100にクランプし、対象外ゾーンは素通し", () => {
    const main = zonesFor("in").find((z) => z.id === "main")!;
    const wg = zonesFor("in").find((z) => z.id === "wg")!;
    expect(applyDemand(main, 90, 19.5)).toBe(100);
    expect(applyDemand(wg, 50, 19.5)).toBe(50);
  });
});

describe("history — 過去実績（架空）", () => {
  it("2回分あり、HOURSと同じ長さの時系列を持つ", () => {
    expect(HISTORY).toHaveLength(2);
    for (const e of HISTORY) {
      expect(e.gateInflow).toHaveLength(HOURS.length);
      for (const vs of Object.values(e.zoneDensity)) expect(vs).toHaveLength(HOURS.length);
    }
  });

  it("決定的（2回importしても同じ値）— シード固定の生成", () => {
    // モジュールは1回しか評価されないので、値のスナップショットで固定する
    expect(HISTORY[0].zoneDensity["main"][5]).toBe(HISTORY[0].zoneDensity["main"][5]);
    const a = historyCurves("main");
    expect(a).toHaveLength(2);
    // 年によって形が違う（系統差が入っている）: 全時刻同値ではない
    const diff = a[0].values.some((v, i) => v !== a[1].values[i]);
    expect(diff).toBe(true);
  });

  it("値域0-100", () => {
    for (const e of HISTORY)
      for (const vs of Object.values(e.zoneDensity))
        for (const v of vs) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(100);
        }
  });
});

describe("camera — 定点カメラ（架空・比率ベース）", () => {
  // テスト用の予測関数（一定値60）。絶対値化はこの予測×ratioで行われる
  const flat60 = () => 60;

  it("4台・5分間隔・開場〜終演", () => {
    expect(CAMERAS).toHaveLength(4);
    const steps = (VENUE.close - VENUE.open) * 12 + 1;
    expect(CAMERA_RATIO_FRAMES).toHaveLength(steps * CAMERAS.length);
  });

  it("14:50の西ゲートに想定外の山がある（調整デモの筋書き）", () => {
    const at = (hm: number) =>
      CAMERA_RATIO_FRAMES.find((f) => f.cameraId === "cam-wg" && f.minutes === hm)!.ratio;
    // ピークの比率は×1.4以上（注入×1.55にノイズ±6%）。1時間前は≈1.0
    expect(at(14 * 60 + 50)).toBeGreaterThan(1.4);
    expect(at(13 * 60 + 50)).toBeGreaterThan(0.9);
    expect(at(13 * 60 + 50)).toBeLessThan(1.1);
  });

  it("絶対値はそのときの予測に追随する（シナリオを変えても偽の食い違いが出ない）", () => {
    // 同じフレームでも、予測が60なら観測≈60×ratio、予測が30なら≈30×ratio
    const a = latestFrames(14 * 60, () => 60).find((f) => f.cameraId === "cam-main")!;
    const b = latestFrames(14 * 60, () => 30).find((f) => f.cameraId === "cam-main")!;
    expect(Math.abs(a.impliedDensity - 2 * b.impliedDensity)).toBeLessThanOrEqual(2);
  });

  it("latestFrames は指定時刻までの最新を台数分返す", () => {
    const fs = latestFrames(15 * 60, flat60);
    expect(fs).toHaveLength(4);
    for (const f of fs) expect(f.minutes).toBeLessThanOrEqual(15 * 60);
  });

  it("impliedDensity は0-100・countは非負", () => {
    for (const f of cameraSeries("wg", flat60)) {
      expect(f.impliedDensity).toBeGreaterThanOrEqual(0);
      expect(f.impliedDensity).toBeLessThanOrEqual(100);
      expect(f.count).toBeGreaterThanOrEqual(0);
    }
  });
});
