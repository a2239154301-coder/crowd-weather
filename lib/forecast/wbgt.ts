/**
 * WBGT（暑さ指数）物理モデル。
 *
 * 出典: 馬場氏 v4 原本 components/original-v4/mock.jsx の
 * 「PHYSICS CORE ── 暑熱予報エンジン」内、
 * 「5. 日射・WBGT（物理モデル）」セクション（134〜163行付近）を忠実移植。
 * 数式・係数は原本と完全一致させている（改善・簡略化はしていない）。
 *
 * 原本の env は { weather, Ta, RH, v } という命名だったが、
 * このモジュールでは WbgtEnv = { weather, taC, rhPct, windMs } という
 * 明示的な名前に置き換えている（値・計算式そのものは無改変）。
 */

import type { Weather } from "./types";

const RAD = Math.PI / 180;

export type WbgtEnv = {
  weather: Weather;
  /** 気温（℃）。原本の env.Ta */
  taC: number;
  /** 相対湿度（%）。原本の env.RH */
  rhPct: number;
  /** 風速（m/s）。原本の env.v */
  windMs: number;
};

/**
 * 直達日射・散乱日射（W/m^2）。
 * 原本コメント:
 *   AM = Kasten-Young 大気路程
 *   tau = 晴天透過率
 * 曇り・雨は経験的な減衰係数を直達・散乱それぞれに掛ける。
 * 原本: function irradiance(alt, weather)
 */
export function irradiance(altDeg: number, weather: Weather): { dir: number; dif: number } {
  if (altDeg <= 0) return { dir: 0, dif: 0 };
  const s = Math.sin(altDeg * RAD);
  const AM = 1 / (s + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364)); // Kasten-Young 大気路程
  const tau = Math.pow(0.7, Math.pow(AM, 0.678)); // 晴天透過率
  let dir = 1367 * tau * s;
  let dif = 0.3 * (1 - tau) * 1367 * s;
  if (weather === "cloudy") {
    dir *= 0.25;
    dif *= 1.6;
  }
  if (weather === "rainy") {
    dir *= 0.03;
    dif *= 1.0;
  }
  return { dir, dif };
}

/**
 * 湿球温度（℃）。Stull (2011) の近似式。
 * 原本: const wetBulb = (Ta, RH) => ... // Stull (2011)
 */
export function wetBulbStull(taC: number, rhPct: number): number {
  return (
    taC * Math.atan(0.151977 * Math.sqrt(rhPct + 8.313659)) +
    Math.atan(taC + rhPct) -
    Math.atan(rhPct - 1.676331) +
    0.00391838 * Math.pow(rhPct, 1.5) * Math.atan(0.023101 * rhPct) -
    4.686035
  );
}

/**
 * 日陰率・太陽高度・気象条件から WBGT を合成する。
 * 自然湿球温度・黒球温度を近似し、日本生気象学会の指針で使われる
 * 屋外3系数の重み（0.7 / 0.2 / 0.1）で統合する。
 * 原本: function wbgtAt(shadeFrac, alt, env, svf = 0.65)
 *   S   = 日陰でも天空散乱は残る、という前提で合成した実効日射
 *   Tnw = 自然湿球（風で冷やされる）
 *   Tg  = 黒球（日射で温まる）
 */
export function wbgtPhysical(
  shadeFraction: number,
  sunAltitudeDeg: number,
  env: WbgtEnv,
  svf = 0.65
): { wbgt: number; solarWm2: number; globeC: number } {
  const { dir, dif } = irradiance(sunAltitudeDeg, env.weather);
  const S = (1 - shadeFraction) * (dir + dif) + shadeFraction * dif * svf; // 日陰でも天空散乱は残る
  const Tw = wetBulbStull(env.taC, env.rhPct);
  const Tnw = Tw + (0.006 * S) / (1 + 0.8 * env.windMs); // 自然湿球
  const Tg = env.taC + (0.0295 * S) / (1 + Math.pow(env.windMs, 0.6)); // 黒球
  return { wbgt: 0.7 * Tnw + 0.2 * Tg + 0.1 * env.taC, solarWm2: S, globeC: Tg };
}
