import type { EventDate, Weather } from "@/lib/forecast/types";

/**
 * Open-Meteo から現在の実況を取り、Scenario に流し込める形へ整える。
 *
 * 馬場v4の fetchLive を移植したもの。選定理由（v4のコメントを踏襲）:
 * 無料・APIキー不要・CORS許可のため、クライアント直fetchでVercelにそのまま置ける。
 * 日照・影・WBGTは開催日と時刻から実計算しているので、
 * 「開催日=今日・時刻=現在」にセットするだけで実況の太陽になる。
 *
 * データの出所ラベル: この値を使うときは UI に「LIVE」を表示する
 * （手入力値と実況値を画面上で区別する — 実データでない値を実データに見せない）。
 */

/** 東京（会場のデモ座標）。会場の地名を入れると `geocode()` で差し替わる */
export const DEFAULT_GEO = { lat: 35.6895, lon: 139.6917 };

export type GeoPlace = { name: string; lat: number; lon: number };

/**
 * 地名 → 緯度経度。**国土地理院（GSI）の住所検索API**を使う。
 *
 * 馬場氏の要望「会場の場所（東京とか大阪とか）を入れるエリアがあってもいい。
 * それをmeteoのAPIとリンクさせて場所を取ってくる」への実装。
 * 緯度経度は実況の取得先になるだけでなく、**太陽位置の計算にも効く**
 * （緯度で南中高度が変わる＝同じ建物でも影の長さが変わる）。
 *
 * ⚠ Open-Meteo の Geocoding API を最初に使ったが、**日本語（漢字）で引けない**
 * （2026-08-11実測: 「大阪」で0件・"Osaka"なら大阪市が返る）。表示名は日本語化されるが
 * 検索キーはASCIIのみ。日本のイベント現場で使う以上これは通らないため、
 * 漢字をそのまま引ける国土地理院APIに変更した。無料・APIキー不要・CORS許可。
 * 「幕張メッセ」のような施設名でも引ける。
 *
 * GSIは表記ゆれに寛容な代わりに別字（大阪→大坂）も返すため、
 * **入力文字列を含む結果を優先**して並べ替える。
 */
export async function geocode(query: string): Promise<GeoPlace[]> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GSI Geocoding HTTP ${res.status}`);
  const data = (await res.json()) as {
    properties: { title: string };
    geometry: { coordinates: [number, number] };
  }[];

  const all = (data ?? [])
    .filter((r) => r?.geometry?.coordinates?.length === 2)
    .map((r) => ({
      name: r.properties.title,
      lon: r.geometry.coordinates[0],
      lat: r.geometry.coordinates[1],
    }));

  // 入力語をそのまま含むものを先に（別字マッチを後ろへ回す）
  const exact = all.filter((p) => p.name.includes(query));
  return (exact.length > 0 ? exact : all).slice(0, 5);
}

export type LiveWeather = {
  weather: Weather;
  tempC: number;
  rhPct: number;
  windMs: number;
  date: EventDate;
  /** 実況時刻 "HH:MM"（表示用） */
  timeLabel: string;
  /** 実況時刻（0時からの分）。タイムラインへの反映用 */
  minutes: number;
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** WMO weather_code → 3値の天候。v4と同じ割り切り（51以上は全部「雨」扱い） */
function wmoToWeather(code: number): Weather {
  if (code === 0) return "sunny";
  if (code >= 1 && code <= 3) return "cloudy";
  if (code === 45 || code === 48) return "cloudy"; // 霧
  return "rainy"; // 51-67 霧雨/雨, 71-77 雪, 80-82 にわか雨, 95-99 雷雨
}

export async function fetchLiveWeather(geo = DEFAULT_GEO): Promise<LiveWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&timezone=Asia%2FTokyo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = (await res.json()) as {
    current?: {
      time: string;
      temperature_2m: number;
      relative_humidity_2m: number;
      wind_speed_10m: number;
      weather_code: number;
    };
  };
  const cur = data.current;
  if (!cur) throw new Error("Open-Meteo: current ブロックがありません");

  // timezone=Asia/Tokyo 指定時、current.time はローカル時刻文字列（例 "2026-08-11T14:30"）
  const [dPart, tPart] = String(cur.time).split("T");
  const [y, mo, d] = dPart.split("-").map(Number);
  const [h, min] = (tPart || "00:00").split(":").map(Number);

  return {
    weather: wmoToWeather(cur.weather_code),
    // クランプ幅はUIスライダーの可動域に合わせる（v4踏襲）
    tempC: clamp(Math.round(cur.temperature_2m), 22, 39),
    rhPct: clamp(Math.round(cur.relative_humidity_2m / 5) * 5, 30, 95),
    windMs: clamp(Math.round((cur.wind_speed_10m / 3.6) * 10) / 10, 0.2, 5), // km/h → m/s
    date: { y, mo, d, label: `${mo}/${d} 実況` },
    timeLabel: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
    minutes: h * 60 + min,
  };
}
