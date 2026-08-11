// 検証スクリプト: 移植版 lib/forecast/wbgt.ts / lib/forecast/tent.ts が
// 馬場氏v4 原本 (components/original-v4/mock.jsx) の物理計算と一致することを確認する。
//
// 実行: npx tsx scripts/verify-wbgt.mjs
//
// 下の REFERENCE ブロックは components/original-v4/mock.jsx の
// 「PHYSICS CORE」セクション（irradiance / wetBulb / wbgtAt, 134〜163行）と
// 「7. テント配置提案」セクション（TENT / tentPlan, 189〜208行）から
// 数式・定数・演算子を一字一句コピーしたもの。改変していない。
// （tentPlan だけは、原本がモジュールグローバル SZONES を参照していたのに対し、
//   この検証スクリプトではそれを引数 SZONES として受け取れるようにシグネチャを
//   1箇所だけ変更している＝ロジック本体は無改変）

import {
  irradiance as portedIrradiance,
  wetBulbStull as portedWetBulb,
  wbgtPhysical as portedWbgtPhysical,
} from "../lib/forecast/wbgt.ts";
import { tentPlan as portedTentPlan } from "../lib/forecast/tent.ts";

/* ============================================================
 * REFERENCE ── 原本からのコピー（無改変）
 * ============================================================ */
const RAD = Math.PI / 180;

function irradiance(alt, weather) {
  if (alt <= 0) return { dir: 0, dif: 0 };
  const s = Math.sin(alt * RAD);
  const AM = 1 / (s + 0.50572 * Math.pow(alt + 6.07995, -1.6364));   // Kasten-Young 大気路程
  const tau = Math.pow(0.7, Math.pow(AM, 0.678));                    // 晴天透過率
  let dir = 1367 * tau * s, dif = 0.30 * (1 - tau) * 1367 * s;
  if (weather === "cloudy") { dir *= 0.25; dif *= 1.6; }
  if (weather === "rainy") { dir *= 0.03; dif *= 1.0; }
  return { dir, dif };
}
const wetBulb = (Ta, RH) =>                                          // Stull (2011)
  Ta * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) + Math.atan(Ta + RH)
  - Math.atan(RH - 1.676331) + 0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) - 4.686035;

function wbgtAt(shadeFrac, alt, env, svf = 0.65) {
  const { dir, dif } = irradiance(alt, env.weather);
  const S = (1 - shadeFrac) * (dir + dif) + shadeFrac * dif * svf;   // 日陰でも天空散乱は残る
  const Tw = wetBulb(env.Ta, env.RH);
  const Tnw = Tw + 0.006 * S / (1 + 0.8 * env.v);                    // 自然湿球
  const Tg = env.Ta + 0.0295 * S / (1 + Math.pow(env.v, 0.6));       // 黒球
  return { wbgt: 0.7 * Tnw + 0.2 * Tg + 0.1 * env.Ta, S, Tg };
}

const TENT = 18; // 3m × 6m
// シグネチャのみ変更: (steps) → (steps, SZONES) ＝ グローバル依存を外すため
function tentPlan(steps, SZONES) {
  const perZone = {};
  for (const z of SZONES) {
    if (!z.queueArea) continue;
    let worst = null, hours = [];
    for (const st of steps) {
      if (st.night) continue;
      const zs = st.zones.find(q => q.id === z.id);
      if (zs.wbgt >= 28 && zs.shade < 0.6) {
        hours.push(st.m);
        const need = Math.ceil(z.queueArea * (1 - zs.shade) / TENT);
        if (!worst || need > worst.need) worst = { need, at: st.m, shade: zs.shade, wbgt: zs.wbgt };
      }
    }
    if (worst) perZone[z.id] = { zone: z, ...worst, from: Math.min(...hours), to: Math.max(...hours) + 30 };
  }
  const list = Object.values(perZone).sort((a, b) => b.need - a.need);
  return { list, total: list.reduce((s, x) => s + x.need, 0) };
}

/* ============================================================
 * 検証ハーネス
 * ============================================================ */
let passCount = 0;
let failCount = 0;

function assertClose(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  if (Number.isNaN(diff) || diff > tol) {
    failCount++;
    console.error(`FAIL ${label}: actual=${actual} expected=${expected} diff=${diff}`);
  } else {
    passCount++;
    console.log(`PASS ${label} (diff=${diff.toExponential(3)})`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failCount++;
    console.error(`FAIL ${label}:\n  actual=${a}\n  expected=${e}`);
  } else {
    passCount++;
    console.log(`PASS ${label}`);
  }
}

const TOL = 1e-9;

/* ---------- 1. irradiance を直接比較 ---------- */
console.log("\n--- irradiance() ---");
for (const weather of ["sunny", "cloudy", "rainy"]) {
  for (const alt of [5, 30, 60]) {
    const ref = irradiance(alt, weather);
    const got = portedIrradiance(alt, weather);
    assertClose(got.dir, ref.dir, TOL, `irradiance dir alt=${alt} ${weather}`);
    assertClose(got.dif, ref.dif, TOL, `irradiance dif alt=${alt} ${weather}`);
  }
}
// 太陽が地平線下（alt<=0）の境界ケース
for (const alt of [0, -5]) {
  const ref = irradiance(alt, "sunny");
  const got = portedIrradiance(alt, "sunny");
  assertClose(got.dir, ref.dir, TOL, `irradiance dir alt=${alt} (night)`);
  assertClose(got.dif, ref.dif, TOL, `irradiance dif alt=${alt} (night)`);
}

/* ---------- 2. wetBulb を直接比較 ---------- */
console.log("\n--- wetBulbStull() ---");
for (const [Ta, RH] of [[34, 60], [30, 70], [26, 85], [22, 95]]) {
  const ref = wetBulb(Ta, RH);
  const got = portedWetBulb(Ta, RH);
  assertClose(got, ref, TOL, `wetBulb Ta=${Ta} RH=${RH}`);
}

/* ---------- 3. wbgtAt / wbgtPhysical を比較（晴/曇/雨 × 高度5/30/60 × 日向/日陰） ---------- */
console.log("\n--- wbgtPhysical() vs wbgtAt() ---");
const ENVS = {
  sunny: { weather: "sunny", Ta: 34, RH: 60, v: 1.5 },
  cloudy: { weather: "cloudy", Ta: 30, RH: 70, v: 2.0 },
  rainy: { weather: "rainy", Ta: 26, RH: 85, v: 3.0 },
};
const toWbgtEnv = (env) => ({ weather: env.weather, taC: env.Ta, rhPct: env.RH, windMs: env.v });

let caseCount = 0;
for (const weather of ["sunny", "cloudy", "rainy"]) {
  for (const alt of [5, 30, 60]) {
    for (const shade of [0.08, 0.85]) { // 0.08=日向相当, 0.85=日陰相当（原本 isShaded() が使う値）
      caseCount++;
      const env = ENVS[weather];
      const ref = wbgtAt(shade, alt, env); // svf はデフォルト(0.65)のまま＝両者一致
      const got = portedWbgtPhysical(shade, alt, toWbgtEnv(env));
      const label = `wbgt weather=${weather} alt=${alt} shade=${shade}`;
      assertClose(got.wbgt, ref.wbgt, TOL, `${label} [wbgt]`);
      assertClose(got.solarWm2, ref.S, TOL, `${label} [S]`);
      assertClose(got.globeC, ref.Tg, TOL, `${label} [Tg]`);
    }
  }
}
console.log(`\n(wbgt比較: ${caseCount}条件 × 3値 = ${caseCount * 3}アサーション)`);

// svf を明示的に変えても一致することの確認（デフォルト値以外の経路も通す）
{
  const env = ENVS.sunny;
  const ref = wbgtAt(0.4, 40, env, 0.5);
  const got = portedWbgtPhysical(0.4, 40, toWbgtEnv(env), 0.5);
  assertClose(got.wbgt, ref.wbgt, TOL, "wbgt svf=0.5 explicit");
}

/* ---------- 4. tentPlan を比較（3ゾーン × 5ステップの合成データ） ---------- */
console.log("\n--- tentPlan() ---");
const SZONES = [
  { id: "z1", name: "Zone1（駅連絡通路相当）", queueArea: 220 },
  { id: "z2", name: "Zone2（西ゲート相当）", queueArea: 180 },
  { id: "z3", name: "Zone3（メインステージ相当・テント対象外）", queueArea: 0 },
];

// steps: m はテント判定用の分。3.との対応: 原本の st.m ↔ 移植版の st.minutes
const rawSteps = [
  { m: 660, night: false, zones: [
    { id: "z1", shade: 0.50, wbgt: 29.0 }, // 対象: shade<0.6 & wbgt>=28
    { id: "z2", shade: 0.70, wbgt: 30.0 }, // 対象外: shade>=0.6
    { id: "z3", shade: 0.20, wbgt: 29.0 },
  ]},
  { m: 690, night: false, zones: [
    { id: "z1", shade: 0.40, wbgt: 28.0 }, // 対象
    { id: "z2", shade: 0.50, wbgt: 29.0 }, // 対象
    { id: "z3", shade: 0.10, wbgt: 30.0 },
  ]},
  { m: 720, night: true, zones: [ // 夜間ステップは判定から除外される
    { id: "z1", shade: 0.00, wbgt: 40.0 },
    { id: "z2", shade: 0.00, wbgt: 40.0 },
    { id: "z3", shade: 0.00, wbgt: 40.0 },
  ]},
  { m: 750, night: false, zones: [
    { id: "z1", shade: 0.55, wbgt: 28.5 }, // 対象
    { id: "z2", shade: 0.30, wbgt: 31.0 }, // 対象（z2の最悪ケース）
    { id: "z3", shade: 0.05, wbgt: 31.0 },
  ]},
  { m: 780, night: false, zones: [
    { id: "z1", shade: 0.65, wbgt: 32.0 }, // 対象外: shade>=0.6
    { id: "z2", shade: 0.90, wbgt: 33.0 }, // 対象外: shade>=0.6
    { id: "z3", shade: 0.60, wbgt: 33.0 },
  ]},
];

const refTentSteps = rawSteps; // st.m / st.night / st.zones をそのまま使う（原本の形）
const portedTentSteps = rawSteps.map((st) => ({
  minutes: st.m,
  night: st.night,
  zones: st.zones,
}));

const refTent = tentPlan(refTentSteps, SZONES);
const gotTent = portedTentPlan(portedTentSteps, SZONES);

assertDeepEqual(gotTent, refTent, "tentPlan() 出力の完全一致（list/total）");
console.log("tentPlan() 実際の出力:", JSON.stringify(gotTent, null, 2));

/* ---------- 結果 ---------- */
console.log(`\n============================================================`);
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
console.log(`============================================================`);
if (failCount > 0) {
  process.exit(1);
}
