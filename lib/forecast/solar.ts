/**
 * 太陽位置の実計算（NOAA Solar Calculator の近似式）。
 *
 * これまでのデモ用モデルは「日の出=東、南中=南、日の入り=西」を時間で線形補間した簡略版だった。
 * ここでは **緯度経度・日付・時刻** から実際の方位角と高度を求める。
 * これにより「7月20日の15時、この会場で、影がどこに落ちるか」が本当に計算できる。
 *
 * 精度: 太陽位置は±0.5°程度。屋外熱環境の議論には十分。
 * 大気差（refraction）と標高は無視している。
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type GeoPoint = {
  /** 緯度（北緯が正） */
  lat: number;
  /** 経度（東経が正） */
  lon: number;
  /** 標準時のUTCオフセット（時）。日本なら +9 */
  tzOffsetHours: number;
};

export type SolarPosition = {
  /** 方位角（度・北0 / 東90 / 南180 / 西270） */
  azimuthDeg: number;
  /** 高度（度）。負なら地平線下 */
  altitudeDeg: number;
  /**
   * 大気圏外日射に対する相対的な強さ 0-1。
   * 太陽高度のサインに比例させ、低空では大気を長く通るぶん減衰させる。
   */
  intensity: number;
};

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86_400_000);
}

/**
 * @param date  現地時刻の年月日
 * @param hours 現地時刻（小数可。15.5 なら 15:30）
 */
export function solarPosition(date: Date, hours: number, geo: GeoPoint): SolarPosition {
  const n = dayOfYear(date);
  // 太陽の黄経に相当する角度
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + (hours - 12) / 24);

  // 均時差（分）
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // 赤緯（rad）
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // 真太陽時（分）
  const timeOffset = eqTime + 4 * geo.lon - 60 * geo.tzOffsetHours;
  const trueSolarTime = hours * 60 + timeOffset;
  // 時角（度）。正午が0、午後が正
  const hourAngle = trueSolarTime / 4 - 180;

  const lat = geo.lat * RAD;
  const ha = hourAngle * RAD;

  const cosZenith =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const altitudeDeg = 90 - zenith * DEG;

  let azimuthDeg = 0;
  const sinZen = Math.sin(zenith);
  if (Math.abs(sinZen) > 1e-6) {
    const cosAz = (Math.sin(decl) - Math.sin(lat) * cosZenith) / (Math.cos(lat) * sinZen);
    const az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
    azimuthDeg = hourAngle > 0 ? 360 - az * DEG : az * DEG;
  }

  // 大気路程による減衰。高度が低いほど日射は弱い
  const sinAlt = Math.sin(Math.max(0, altitudeDeg) * RAD);
  const airMass = altitudeDeg > 0 ? 1 / (sinAlt + 0.0001) : Infinity;
  const intensity =
    altitudeDeg <= 0 ? 0 : Math.max(0, sinAlt * Math.pow(0.7, Math.pow(Math.min(airMass, 38), 0.678)));

  return { azimuthDeg, altitudeDeg, intensity: Math.min(1, intensity / 0.75) };
}

/** 日の出・日の入りの時刻（現地時・小数時）。見つからなければ null（白夜・極夜） */
export function daylightWindow(date: Date, geo: GeoPoint): { sunrise: number; sunset: number } | null {
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let prev = solarPosition(date, 0, geo).altitudeDeg;
  for (let h = 0.25; h <= 24; h += 0.25) {
    const alt = solarPosition(date, h, geo).altitudeDeg;
    if (prev < 0 && alt >= 0) sunrise = h;
    if (prev >= 0 && alt < 0) sunset = h;
    prev = alt;
  }
  if (sunrise === null || sunset === null) return null;
  return { sunrise, sunset };
}
