"use client";

/* ============================================================
 * 馬場氏 v4 原本（無改変保存）
 * 出典: https://github.com/77taka777/crowd-weather-app
 * commit 2fe3379 "Route generation through server API"（2026-08-10 19:11）
 * 取得日: 2026-08-11
 * 変更点はこのヘッダと "use client" の2行のみ。
 * デプロイ版 https://crowd-weather-v5.vercel.app/ に対応するソース。
 * ============================================================ */

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Sun, Cloud, CloudRain, Droplets, Users, Thermometer, Umbrella,
  AlertTriangle, MapPin, FileText, Navigation, Shield, Clock,
  Sliders, ChevronRight, Train, Database, Zap, Lock,
  Smartphone, Bell, LifeBuoy, TrendingDown, Layers,
  Play, Pause, Wind, Building2, Compass, Info, Tent, Cpu, Route, Sparkles,
} from "lucide-react";

/* ============================================================
   CROWD WEATHER v3 ── 統合プロトタイプ
   混雑予報 × 暑熱予報エンジン(NOAA×影投影×WBGT) × AIレイヤー(OrcaRouter)
   全タブが同一シナリオ（天候・気温・湿度・風速・開催日・来場規模）に連動
   ============================================================ */

// ---- design tokens ----
const C = {
  ink: "#0A0F1E", panel: "#121A30", panel2: "#0F1728", deep: "#0B1120",
  line: "#22304F", mist: "#EAF0FB", muted: "#8695B8", faint: "#5C6A8C",
  cool: "#38BDF8", safe: "#22C55E", caution: "#FBBF24",
  busy: "#FB923C", danger: "#F43F5E", heat: "#EF4444", violet: "#A78BFA",
  bldg: "#33415C", shadow: "#0C1729",
};
const display = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif";
const mono = "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace";

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const LAT = 35.6895, LON = 139.6917, TZ = 9;      // 東京
const OPEN = 11, CLOSE = 21;                       // イベント時間（時）
const OPEN_M = OPEN * 60, CLOSE_M = CLOSE * 60;    // 同（分）
const HOURS = Array.from({ length: CLOSE - OPEN + 1 }, (_, i) => OPEN + i);

/* ============================================================
   PHYSICS CORE ── 暑熱予報エンジン
   （旧・日陰計算デモを昇格。全タブのWBGTはここで計算する）
   ============================================================ */

/* ---------- 1. 太陽位置：NOAA Solar Calculator 準拠 ---------- */
function dayOfYear(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5) + 1; }
function sunPosition(y, mo, d, minutes, lat = LAT, lon = LON, tz = TZ) {
  const hour = minutes / 60;
  const g = (2 * Math.PI / 365) * (dayOfYear(y, mo, d) - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = minutes + eqtime + 4 * lon - 60 * tz;
  const ha = (tst / 4 - 180) * RAD, latR = lat * RAD;
  const cosZ = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const alt = 90 - zen * DEG;
  let az = 180, sinZ = Math.sin(zen);
  if (Math.abs(sinZ) > 1e-6) {
    let c = -(Math.sin(latR) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(latR) * sinZ);
    az = Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
    if (ha > 0) az = 360 - az;
  }
  return { alt, az };
}

/* ---------- 2. 影投影：footprint を太陽方位の逆へ掃引 ---------- */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}
// 影 = footprint と 平行移動コピー の凸包（凸footprintでは厳密／Minkowski和）
function shadowPolygon(footprint, height, alt, az) {
  if (alt <= 0.5) return null;
  const L = height / Math.tan(alt * RAD);
  const dx = -L * Math.sin(az * RAD), dy = -L * Math.cos(az * RAD);
  return convexHull(footprint.concat(footprint.map(([x, y]) => [x + dx, y + dy])));
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- 3. 敷地（PLATEAU LOD1 相当のダミー） ----------
   実データ接続時は bldg:Building の lod0FootPrint と
   bldg:measuredHeight を平面直角座標に変換して同じ形にすれば差し替え可能 */
const SITE = { w: 320, h: 240 };
const BUILDINGS = [
  { id: "st",  name: "駅ビル",         rect: [0, 206, 150, 240], h: 34 },
  { id: "pk",  name: "立体駐車場",     rect: [196, 212, 262, 240], h: 20 },
  { id: "ce",  name: "商業ビル（東）", rect: [268, 80, 320, 240], h: 48 },
  { id: "cse", name: "商業棟（南東）", rect: [272, 0, 320, 66], h: 26 },
  { id: "ow",  name: "オフィス（西）", rect: [0, 62, 52, 186], h: 56 },
  { id: "ar",  name: "屋内アリーナ",   rect: [0, 0, 50, 50], h: 17 },
];
// queueArea = 実際に人が待つ帯の面積(m²)。テント必要枚数の分母になる
const SZONES = [
  { id: "corr", name: "駅連絡通路",       rect: [60, 182, 145, 202], kind: "動線",   queueArea: 220 },
  { id: "wg",   name: "西ゲート",         rect: [62, 120, 110, 175], kind: "ゲート", queueArea: 180 },
  { id: "eg",   name: "東ゲート",         rect: [205, 125, 258, 180], kind: "ゲート", queueArea: 180 },
  { id: "main", name: "メインステージ前", rect: [115, 60, 255, 120], kind: "観覧",   queueArea: 0 },
  { id: "shop", name: "物販の列",         rect: [62, 20, 140, 55],   kind: "行列",   queueArea: 240 },
  { id: "food", name: "フードコート",     rect: [160, 10, 250, 55],  kind: "行列",   queueArea: 200 },
  { id: "wc",   name: "トイレの列",       rect: [152, 185, 192, 212], kind: "行列",  queueArea: 120 },
  { id: "aid",  name: "救護・給水",       rect: [210, 190, 255, 215], kind: "救護",  queueArea: 100 },
];
const rectPoly = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/* ---------- 4. 日陰率：ゾーン内グリッドサンプリング ---------- */
function shadeRatio(rect, shadows, n = 9) {
  const [x0, y0, x1, y1] = rect; let hit = 0, tot = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = x0 + ((i + 0.5) / n) * (x1 - x0), y = y0 + ((j + 0.5) / n) * (y1 - y0);
    tot++; if (shadows.some(sp => sp && inPoly(x, y, sp))) hit++;
  }
  return hit / tot;
}

/* ---------- 5. 日射・WBGT（物理モデル） ---------- */
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
// 熱中症予防指針（日本生気象学会）
function wbgtStyle(w) {
  if (w < 25) return { c: C.safe,    label: "注意" };
  if (w < 28) return { c: C.caution, label: "警戒" };
  if (w < 31) return { c: C.busy,    label: "厳重警戒" };
  return       { c: C.heat,    label: "危険" };
}
const heatStyle = wbgtStyle; // 旧・簡易版の別名を物理版へ一本化

/* ---------- 6. 一日分の計算（暑熱エンジン用・30分刻み） ---------- */
function computeDay(date, env) {
  const steps = [];
  for (let m = OPEN_M; m <= CLOSE_M; m += 30) {
    const sp = sunPosition(date.y, date.mo, date.d, m);
    const night = sp.alt <= 0.5;
    const shadows = night ? [] : BUILDINGS.map(b => shadowPolygon(rectPoly(b.rect), b.h, sp.alt, sp.az));
    const zones = SZONES.map(z => {
      const sf = night ? 1 : shadeRatio(z.rect, shadows);
      const { wbgt } = wbgtAt(sf, Math.max(sp.alt, 0), env);
      return { id: z.id, shade: sf, wbgt };
    });
    // 敷地全体（建物footprintを除く屋外部分）の日陰率
    let hit = 0, tot = 0;
    for (let x = 5; x < SITE.w; x += 10) for (let y = 5; y < SITE.h; y += 10) {
      if (BUILDINGS.some(b => inPoly(x, y, rectPoly(b.rect)))) continue;
      tot++; if (night || shadows.some(sp2 => sp2 && inPoly(x, y, sp2))) hit++;
    }
    steps.push({ m, sun: sp, night, siteShade: tot ? hit / tot : 0, zones });
  }
  return steps;
}

/* ---------- 7. テント配置提案 ---------- */
const TENT = 18; // 3m × 6m
function tentPlan(steps) {
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

/* ---------- utils ---------- */
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const envOf = s => ({ weather: s.weather, Ta: s.temp, RH: s.RH, v: s.v });

/* ============================================================
   CROWD MODEL ── 混雑予報（会場内・会場外）
   WBGTは上の物理エンジンで計算（簡易式は廃止）
   ============================================================ */

const OCC = { 11:0.20,12:0.42,13:0.60,14:0.75,15:0.88,16:0.95,17:0.90,18:0.82,19:0.80,20:0.72,21:0.55 };

/* cover: 'roof' 常時日陰 / 'east' 東側建物→午前日陰 / 'west' 西側建物→夕方日陰 / null 日向 */
const IN_ZONES = [
  { id:"corr", name:"駅連絡通路", type:"corridor", base:0.9,  x:3,  y:4,  w:44, h:12, cover:"roof" },
  { id:"wg",   name:"西ゲート",   type:"gate",     base:0.85, x:3,  y:21, w:20, h:15, cover:"west" },
  { id:"eg",   name:"東ゲート",   type:"gate",     base:0.85, x:77, y:21, w:20, h:15, cover:"east" },
  { id:"main", name:"メインステージ", type:"stage",  base:1.0,  x:29, y:20, w:42, h:22, cover:null },
  { id:"sub",  name:"サブステージ（屋内）", type:"indoor", base:0.6, x:3, y:44, w:27, h:22, cover:"roof" },
  { id:"shop", name:"物販の列",   type:"queue",    base:0.75, x:33, y:47, w:34, h:17, cover:"east" },
  { id:"food", name:"フードコート", type:"queue",  base:0.7,  x:70, y:44, w:27, h:22, cover:"west" },
  { id:"wc",   name:"トイレの列", type:"queue",    base:0.55, x:3,  y:71, w:19, h:15, cover:null },
  { id:"aid",  name:"救護・給水", type:"aid",      base:0.35, x:25, y:71, w:22, h:15, cover:"roof" },
  { id:"exit", name:"退場動線",   type:"corridor", base:0.9,  x:50, y:71, w:47, h:15, cover:"west" },
];
const OUT_ZONES = [
  { id:"plat",  name:"駅ホーム",     type:"station",  base:0.8,  x:3,  y:5,  w:45, h:13, cover:"roof" },
  { id:"conc",  name:"改札コンコース", type:"station", base:0.9,  x:52, y:5,  w:45, h:13, cover:"roof" },
  { id:"plaza", name:"駅前広場",     type:"corridor", base:0.7,  x:3,  y:24, w:45, h:16, cover:null },
  { id:"alley", name:"商店街の路地", type:"alley",    base:1.0,  x:52, y:24, w:22, h:34, cover:"east" },
  { id:"blvd",  name:"大通り歩道",   type:"corridor", base:0.75, x:78, y:24, w:19, h:34, cover:"west" },
  { id:"bus",   name:"シャトルバス待機列", type:"queue", base:0.8, x:3, y:46, w:45, h:14, cover:null },
  { id:"wgf",   name:"西ゲート前",   type:"gate",     base:0.85, x:3,  y:66, w:45, h:15, cover:"west" },
  { id:"egf",   name:"東ゲート前",   type:"gate",     base:0.85, x:52, y:66, w:45, h:15, cover:"east" },
];

// ---- model ----
const occ = (h, tickets) => (OCC[h] ?? 0) * (tickets / 20000);
const isShaded = (z, h) => z.cover === "roof" || (z.cover === "east" && h <= 13) || (z.cover === "west" && h >= 16) || h >= 20;

function density(z, h, s) {
  let m = 1;
  const egress = h >= CLOSE - 1, opening = h === OPEN;
  if (z.type === "indoor") m *= s.weather === "rainy" ? 1.9 : s.weather === "sunny" ? 0.7 : 1.0;
  if (z.type === "stage")  m *= s.weather === "rainy" ? 0.5 : 1.0;
  if (z.type === "gate")   m *= opening ? 1.7 : egress ? 1.5 : 1.0;
  if (z.type === "corridor") m *= egress ? (z.id === "exit" || z.id === "plaza" ? 2.1 : 1.9) : opening ? 1.5 : 0.5;
  if (z.type === "station")  m *= opening ? 1.8 : egress ? 2.2 : 0.45;
  if (z.type === "alley")    m *= egress ? 2.4 : opening ? 1.4 : 0.55;
  if (z.type === "queue" && s.weather === "sunny") m *= 1.15;
  if (z.type === "queue" && z.id === "bus") m *= egress ? 1.9 : 0.7;
  const raw = occ(h, s.tickets) * z.base * m * 95;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/* WBGT：ゾーンの被陰状態→日陰率に写像し、物理エンジンで実計算。
   （暑熱エンジンと同一の太陽位置・日射・湿球/黒球モデル） */
function wbgt(z, h, s) {
  const sp = sunPosition(s.date.y, s.date.mo, s.date.d, h * 60);
  const sf = isShaded(z, h) ? 0.85 : 0.08;
  let w = wbgtAt(sf, Math.max(sp.alt, 0), envOf(s)).wbgt;
  if (z.type === "queue") w += 1.1;   // 滞留による体感加算
  if (z.type === "gate")  w += 0.6;
  return Math.round(w * 10) / 10;
}
const gateWait = (z, h, s) => Math.round(5 + density(z, h, s) * 0.5);

function densStyle(d){ return d<25?{c:C.safe,label:"快適"}:d<50?{c:C.caution,label:"注意"}:d<75?{c:C.busy,label:"混雑"}:{c:C.danger,label:"危険"}; }

function hourStats(zones, h, s) {
  let maxD=0,maxDZ=zones[0],maxW=0,maxWZ=zones[0];
  for (const z of zones){ const d=density(z,h,s),w=wbgt(z,h,s);
    if(d>maxD){maxD=d;maxDZ=z;} if(w>maxW){maxW=w;maxWZ=z;} }
  return { maxD, maxDZ, maxW, maxWZ };
}

function dayPlan(s) {
  const all=[...IN_ZONES,...OUT_ZONES];
  let peakD=0,peakDZ=all[0],peakDH=OPEN,peakW=0,peakWH=OPEN,corridorDanger=false,outDanger=false;
  for(const h of HOURS) for(const z of all){
    const d=density(z,h,s),w=wbgt(z,h,s);
    if(d>peakD){peakD=d;peakDZ=z;peakDH=h;}
    if(w>peakW){peakW=w;peakWH=h;}
    if((z.type==="corridor"||z.type==="alley")&&d>=82){ corridorDanger=true; if(OUT_ZONES.includes(z)) outDanger=true; }
  }
  let water=1,aid=1,guide=2,mist=false,oneway=false,entryCtl=false,stationCoord=false;
  if(peakW>=31){water+=3;aid+=2;mist=true;} else if(peakW>=28){water+=1;aid+=1;mist=s.temp>=32;}
  if(peakD>=75){guide+=3;oneway=true;}
  if(peakD>=90||corridorDanger){entryCtl=true;guide+=1;}
  if(outDanger){stationCoord=true;guide+=1;}
  const waitMin=Math.round(6+peakD*0.55);
  // 人時比較：従来「厚めに一律」 vs 予報で山谷配置
  const baselinePH = 34 * HOURS.length;
  const optimizedPH = 22 * HOURS.length + (water + aid + guide) * 4;
  const saved = Math.round((1 - optimizedPH / baselinePH) * 100);
  return { peakD,peakDZ,peakDH,peakW:Math.round(peakW*10)/10,peakWH,water,aid,guide,mist,oneway,entryCtl,stationCoord,waitMin,corridorDanger,outDanger,baselinePH,optimizedPH,saved };
}

// 来場者向け：最短待ちゲート＆時間ずらし提案
function gateAdvice(hour, s) {
  const gates = IN_ZONES.filter(z=>z.type==="gate");
  const nowBest = gates.map(g=>({g,wait:gateWait(g,hour,s)})).sort((a,b)=>a.wait-b.wait)[0];
  let shift=null;
  for(const h of HOURS){ if(h<=hour) continue;
    const best=gates.map(g=>({g,h,wait:gateWait(g,h,s)})).sort((a,b)=>a.wait-b.wait)[0];
    if(!shift||best.wait<shift.wait) shift=best; }
  return { nowBest, shift };
}

/* ============================================================
   SHARED ATOMS
   ============================================================ */
const WeatherIcon = ({ w, size=18, color }) =>
  w==="sunny"?<Sun size={size} color={color}/>:w==="rainy"?<CloudRain size={size} color={color}/>:<Cloud size={size} color={color}/>;
const Panel = ({children,style}) => <div style={{background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,...style}}>{children}</div>;
const Eyebrow = ({children}) => <div style={{fontFamily:mono,fontSize:11,letterSpacing:2,color:C.faint,textTransform:"uppercase"}}>{children}</div>;
const Chip = ({c,children}) => <span style={{fontFamily:mono,fontSize:12,fontWeight:600,color:c,background:c+"1A",border:`1px solid ${c}44`,borderRadius:99,padding:"5px 11px"}}>{children}</span>;

// 太陽位置インジケータ（NOAA計算の実高度で描画）
function SunArc({ hour, s }) {
  const sp = sunPosition(s.date.y, s.date.mo, s.date.d, hour*60);
  const t=(hour-OPEN)/(CLOSE-OPEN), r=26, cx=34, cy=32;
  const x=cx-r+2*r*t, y=cy-r*0.9*Math.max(0,Math.min(1,sp.alt/80));
  const set = sp.alt<=0.5;
  return (
    <svg width="68" height="38" style={{overflow:"visible"}}>
      <path d={`M ${cx-r} ${cy} A ${r} ${r*0.9} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={C.line} strokeWidth="1.5" strokeDasharray="3 3"/>
      <circle cx={x} cy={set?cy:y} r="5" fill={set?C.faint:s.weather==="sunny"?C.caution:C.muted}/>
      <text x={cx} y={cy+6} textAnchor="middle" fontSize="8" fill={C.faint} fontFamily={mono}>{set?"日没":`高度${sp.alt.toFixed(0)}°`}</text>
    </svg>
  );
}

// ---- venue / city map ----
function ZoneMap({ zones, hour, s, layer, height=280, mini=false, highlightShade=false, staff=null }) {
  return (
    <div style={{position:"relative",width:"100%",height,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,overflow:"hidden"}}>
      {zones.map(z=>{
        const d=density(z,hour,s), w=wbgt(z,hour,s), shaded=isShaded(z,hour);
        const col = layer==="crowd"?densStyle(d).c:heatStyle(w).c;
        const val = layer==="crowd"?d:w;
        const glow = layer==="crowd"?d>74:w>=31;
        const dim = highlightShade && !shaded;
        return (
          <div key={z.id} title={z.name}
            style={{position:"absolute",left:`${z.x}%`,top:`${z.y}%`,width:`${z.w}%`,height:`${z.h}%`,
              background:col+(dim?"14":"2E"),border:`1.5px solid ${col}${dim?"55":""}`,borderRadius:8,
              padding:mini?3:6,display:"flex",flexDirection:"column",justifyContent:"space-between",
              transition:"all .35s ease",boxShadow:glow?`0 0 14px ${col}66`:"none",opacity:dim?0.55:1}}>
            <div style={{fontSize:mini?8:10,color:C.mist,lineHeight:1.15,fontWeight:500}}>
              {z.name}{layer==="heat"&&shaded?<span style={{color:C.cool}}> ☂</span>:null}
            </div>
            {!mini&&<div style={{fontFamily:mono,fontWeight:700,fontSize:15,color:col,alignSelf:"flex-end"}}>{val}</div>}
          </div>
        );
      })}
      {staff&&staff.map((p,i)=>(
        <div key={i} title={p.label}
          style={{position:"absolute",left:`${p.x}%`,top:`${p.y}%`,transform:"translate(-50%,-50%)",
            width:16,height:16,borderRadius:"50%",background:p.c,border:`2px solid ${C.ink}`,
            display:"grid",placeItems:"center",fontSize:8,fontWeight:800,color:C.ink,fontFamily:mono}}>{p.t}</div>
      ))}
    </div>
  );
}

// 配置図：推奨スタッフをゾーン上にプロット
function staffDots(s, plan) {
  const dots=[];
  const put=(zone,t,c,label,n)=>{ for(let i=0;i<n;i++) dots.push({x:zone.x+zone.w*(0.25+0.25*i),y:zone.y+zone.h*0.5,t,c,label}); };
  const hotQ=[...IN_ZONES].filter(z=>z.type==="queue"||z.type==="gate").sort((a,b)=>wbgt(b,plan.peakWH,s)-wbgt(a,plan.peakWH,s));
  const denseC=[...IN_ZONES].filter(z=>z.type==="corridor"||z.type==="gate").sort((a,b)=>density(b,plan.peakDH,s)-density(a,plan.peakDH,s));
  put(hotQ[0],"水",C.cool,"給水",Math.min(2,plan.water)); if(plan.water>2&&hotQ[1]) put(hotQ[1],"水",C.cool,"給水",1);
  put(denseC[0],"誘",C.caution,"誘導",Math.min(3,plan.guide)); if(plan.guide>3&&denseC[1]) put(denseC[1],"誘",C.caution,"誘導",1);
  const aidZ=IN_ZONES.find(z=>z.id==="aid"); put(aidZ,"救",C.safe,"救護",Math.min(2,plan.aid));
  return dots;
}

/* ============================================================
   ROOT
   ============================================================ */
export default function CrowdWeather() {
  const [view,setView]=useState("ops"); // ops | shade | app | ai | data
  const [s,setS]=useState({weather:"sunny",temp:34,RH:60,v:1.5,tickets:24000,date:{y:2026,mo:8,d:8,label:"8/8 真夏"}});
  const [hour,setHourRaw]=useState(16);
  const [t,setTRaw]=useState(16*60);   // 暑熱エンジン用（分）
  const [scope,setScope]=useState("in"); // in | out
  const [layer,setLayer]=useState("crowd");
  const [showPlan,setShowPlan]=useState(false);

  // 時間はタブ間で同期（時⇄分）
  const setHour=h=>{setHourRaw(h);setTRaw(h*60);};
  const setT=m=>{setTRaw(m);setHourRaw(Math.max(OPEN,Math.min(CLOSE,Math.round(m/60))));};

  const plan=useMemo(()=>dayPlan(s),[s]);
  const zones = scope==="in"?IN_ZONES:OUT_ZONES;
  const now=useMemo(()=>hourStats(zones,hour,s),[zones,hour,s]);
  const dayAlert=densStyle(plan.peakD);
  const set=(k,v)=>setS(p=>({...p,[k]:v}));

  /* ---------- LIVE ── 現在の東京の実況を全タブに反映 ----------
     Open-Meteo（無料・APIキー不要・CORS許可）を直接fetch。
     サーバーレス関数や秘密鍵なしで動くので、Vercel/Netlifyへ
     そのままデプロイしても機能する。
     日照・影・WBGTは date/t から実計算しているので、
     開催日=今日・時刻=現在 にセットするだけで実況の太陽になる。 */
  const [liveBusy,setLiveBusy]=useState(false);
  const [live,setLive]=useState(null); // null | "HH:MM" | "error"
  const clampN=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
  // WMO weather_code → sunny/cloudy/rainy
  const wmoToCond=code=>{
    if(code===0) return "sunny";
    if(code>=1&&code<=3) return "cloudy";
    if(code===45||code===48) return "cloudy";
    return "rainy"; // 51-67 drizzle/rain, 71-77 snow, 80-82 shower, 95-99 thunderstorm
  };
  const fetchLive=async()=>{
    if(liveBusy) return;
    setLiveBusy(true); setLive(null);
    try{
      const url=`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
        +`&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`
        +`&timezone=Asia%2FTokyo`;
      const res=await fetch(url);
      if(!res.ok) throw new Error("http "+res.status);
      const data=await res.json();
      const cur=data.current;
      if(!cur) throw new Error("no current block");
      const cond=wmoToCond(cur.weather_code);
      // Open-Meteoのtimezone=Asia/Tokyoで返るcurrent.timeはローカル時刻文字列（例 "2026-08-10T14:30"）
      const [dPart,tPart]=String(cur.time).split("T");
      const [jy,jmo,jd]=dPart.split("-").map(Number);
      const [jh,jmin]=(tPart||"00:00").split(":").map(Number);
      setS(p=>({...p,
        weather:cond,
        temp:clampN(Math.round(cur.temperature_2m),22,39),
        RH:clampN(Math.round(cur.relative_humidity_2m/5)*5,30,95),
        v:clampN(Math.round((cur.wind_speed_10m/3.6)*10)/10,0.2,5), // km/h→m/s
        date:{y:jy,mo:jmo,d:jd,label:`${jmo}/${jd} 実況`},
      }));
      setT(clampN(jh*60+jmin,OPEN_M,CLOSE_M));
      setLive(`${String(jh).padStart(2,"0")}:${String(jmin).padStart(2,"0")}`);
    }catch(e){ setLive("error"); }
    finally{ setLiveBusy(false); }
  };

  return (
    <div style={{minHeight:"100vh",background:C.ink,color:C.mist,fontFamily:display}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        input[type=range]{-webkit-appearance:none;appearance:none;height:4px;border-radius:99px;background:${C.line};outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${C.cool};border:3px solid ${C.ink};cursor:pointer;box-shadow:0 0 0 1px ${C.line}}
        input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:${C.cool};border:3px solid ${C.ink};cursor:pointer}
        *{box-sizing:border-box}
        @media(max-width:900px){.cw-grid{grid-template-columns:1fr!important}}`}</style>

      <div style={{maxWidth:1180,margin:"0 auto",padding:"22px 18px 64px"}}>

        {/* ---------- header ---------- */}
        <header style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:14,justifyContent:"space-between",marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{position:"relative",width:40,height:40,display:"grid",placeItems:"center"}}>
              <Cloud size={34} color={C.cool}/><Users size={15} color={C.ink} style={{position:"absolute",bottom:6}}/>
            </div>
            <div>
              <div style={{fontWeight:700,fontSize:20,letterSpacing:1}}>CROWD&nbsp;WEATHER</div>
              <div style={{fontFamily:mono,fontSize:11,color:C.muted,letterSpacing:1}}>混雑は、予報できる。</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:4,background:C.panel,border:`1px solid ${C.line}`,borderRadius:12,padding:4,flexWrap:"wrap"}}>
              {[["ops","主催者コンソール",<Sliders key="a" size={13}/>],
                ["shade","暑熱エンジン",<Sun key="s" size={13}/>],
                ["app","来場者アプリ",<Smartphone key="b" size={13}/>],
                ["ai","AIレイヤー",<Cpu key="i" size={13}/>],
                ["data","データ設計",<Database key="c" size={13}/>]].map(([k,l,ic])=>(
                <button key={k} onClick={()=>setView(k)}
                  style={{display:"flex",alignItems:"center",gap:6,padding:"8px 12px",borderRadius:9,cursor:"pointer",
                    fontWeight:600,fontSize:12.5,border:"none",
                    background:view===k?C.cool:"transparent",color:view===k?C.ink:C.muted}}>{ic}{l}</button>
              ))}
            </div>
            <button onClick={fetchLive} disabled={liveBusy}
              style={{display:"flex",alignItems:"center",gap:7,padding:"9px 14px",borderRadius:99,
                cursor:liveBusy?"default":"pointer",fontWeight:700,fontSize:12.5,
                border:`1px solid ${live==="error"?C.danger:C.cool}66`,
                background:C.panel,color:live==="error"?C.danger:C.cool}}>
              {live&&live!=="error"
                ? <span style={{width:7,height:7,borderRadius:99,background:C.safe,boxShadow:`0 0 6px ${C.safe}`}}/>
                : <Zap size={14}/>}
              {liveBusy?"実況取得中…":live==="error"?"取得失敗・再試行":live?`LIVE ${live} 反映済`:"現在の実況を反映"}
            </button>
            <div style={{display:"flex",alignItems:"center",gap:8,background:C.panel,border:`1px solid ${dayAlert.c}55`,borderRadius:99,padding:"8px 14px"}}>
              <AlertTriangle size={16} color={dayAlert.c}/>
              <div>
                <div style={{fontFamily:mono,fontSize:10,color:C.faint,letterSpacing:1}}>本日の最大警戒</div>
                <div style={{fontWeight:700,fontSize:13,color:dayAlert.c}}>{dayAlert.label}・混雑{plan.peakD} / 暑熱{heatStyle(plan.peakW).label}</div>
              </div>
            </div>
          </div>
        </header>

        <div style={{fontFamily:mono,fontSize:11,color:C.faint,marginBottom:14}}>
          夏フェス想定・屋外会場 ／ {s.date.label}・開場 {OPEN}:00 → 終演 {CLOSE}:00 ／ シナリオ（天候・気温・湿度・風・来場規模）は全タブ連動 ／ WBGTは暑熱エンジン（NOAA太陽位置×日射×湿球黒球）の実計算値
        </div>

        {view==="ops"&&(<>
          {/* ---------- 予報ストリップ ---------- */}
          <Panel style={{padding:16,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div><Eyebrow>Hourly Forecast ── 時間帯別予報</Eyebrow>
                <div style={{fontWeight:600,fontSize:15,marginTop:3}}>「今を見る」から「先を読む」へ</div></div>
              <div style={{fontFamily:mono,fontSize:11,color:C.faint}}>タップでマップに反映 ↓</div>
            </div>
            <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:4}}>
              {HOURS.map(h=>{
                const st=hourStats(zones,h,s),ds=densStyle(st.maxD),hs=heatStyle(st.maxW),active=h===hour;
                return (
                  <button key={h} onClick={()=>setHour(h)}
                    style={{flex:"0 0 auto",width:78,background:active?C.panel2:"transparent",
                      border:`1px solid ${active?C.cool:C.line}`,borderRadius:12,padding:"10px 6px",
                      cursor:"pointer",color:C.mist,textAlign:"center",transition:"all .15s"}}>
                    <div style={{fontFamily:mono,fontSize:13,color:active?C.cool:C.muted}}>{h}:00</div>
                    <div style={{margin:"6px 0"}}><WeatherIcon w={s.weather} color={C.muted} size={17}/></div>
                    <div style={{height:44,display:"flex",alignItems:"flex-end",justifyContent:"center",gap:5}}>
                      <div title="混雑指数" style={{width:12,height:`${Math.max(6,st.maxD*0.42)}px`,background:ds.c,borderRadius:3}}/>
                      <div title="暑熱指数" style={{width:12,height:`${Math.max(6,(st.maxW-20)*3.4)}px`,background:hs.c,borderRadius:3,opacity:0.85}}/>
                    </div>
                    <div style={{fontFamily:mono,fontSize:11,marginTop:5,color:ds.c}}>{st.maxD}</div>
                  </button>
                );
              })}
            </div>
            <div style={{display:"flex",gap:16,marginTop:8,fontFamily:mono,fontSize:10,color:C.faint,flexWrap:"wrap"}}>
              <span style={{display:"flex",alignItems:"center",gap:5}}><i style={{width:9,height:9,background:C.busy,borderRadius:2,display:"inline-block"}}/>混雑指数</span>
              <span style={{display:"flex",alignItems:"center",gap:5}}><i style={{width:9,height:9,background:C.heat,borderRadius:2,display:"inline-block"}}/>暑熱指数(WBGT)</span>
              <span style={{color:C.faint}}>※ 表示中スコープ（{scope==="in"?"会場内":"会場外"}）の最大値</span>
            </div>
          </Panel>

          <div className="cw-grid" style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1.15fr)",gap:16}}>
            {/* --- Product 01 --- */}
            <Panel style={{padding:18}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <Sliders size={15} color={C.cool}/><Eyebrow>Product 01 ── 主催者・警備会社向け</Eyebrow></div>
              <div style={{fontWeight:600,fontSize:16,marginBottom:16}}>予報が、そのままシフトになる。</div>

              <div style={{marginBottom:14}}>
                <div style={{fontSize:12,color:C.muted,marginBottom:7}}>天候</div>
                <div style={{display:"flex",gap:8}}>
                  {[["sunny","晴"],["cloudy","曇"],["rainy","雨"]].map(([k,l])=>(
                    <button key={k} onClick={()=>set("weather",k)}
                      style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                        padding:"9px 0",borderRadius:10,cursor:"pointer",fontWeight:600,fontSize:13,
                        background:s.weather===k?C.cool:C.panel2,color:s.weather===k?C.ink:C.muted,
                        border:`1px solid ${s.weather===k?C.cool:C.line}`}}>
                      <WeatherIcon w={k} color={s.weather===k?C.ink:C.muted} size={16}/>{l}</button>
                  ))}
                </div>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <span style={{fontSize:12,color:C.muted}}>予想最高気温</span>
                  <span style={{fontFamily:mono,fontWeight:600,color:s.temp>=33?C.heat:C.mist}}>{s.temp}℃</span></div>
                <input type="range" min={22} max={39} value={s.temp} onChange={e=>set("temp",+e.target.value)} style={{width:"100%"}}/>
              </div>
              <div style={{marginBottom:18}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <span style={{fontSize:12,color:C.muted}}>チケット販売数（来場規模の最重要変数）</span>
                  <span style={{fontFamily:mono,fontWeight:600}}>{s.tickets.toLocaleString()}</span></div>
                <input type="range" min={5000} max={40000} step={1000} value={s.tickets} onChange={e=>set("tickets",+e.target.value)} style={{width:"100%"}}/>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
                {[
                  {ic:<Users size={15} color={dayAlert.c}/>,k:"混雑ピーク",v:`${plan.peakD}`,sub:`${plan.peakDH}:00 ${plan.peakDZ.name}`,c:dayAlert.c},
                  {ic:<Clock size={15} color={C.busy}/>,k:"最大待機列",v:`${plan.waitMin}分`,sub:"ゲート想定",c:C.busy},
                  {ic:<Thermometer size={15} color={heatStyle(plan.peakW).c}/>,k:"暑熱ピーク",v:`${plan.peakW}`,sub:`WBGT ${heatStyle(plan.peakW).label}`,c:heatStyle(plan.peakW).c},
                  {ic:<Train size={15} color={plan.outDanger?C.danger:C.safe}/>,k:"会場外・駅動線",v:plan.outDanger?"危険":"許容",sub:"開場前・終演後の詰まり",c:plan.outDanger?C.danger:C.safe},
                ].map((m,i)=>(
                  <div key={i} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:"11px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,color:C.muted,fontSize:11}}>{m.ic}{m.k}</div>
                    <div style={{fontFamily:mono,fontWeight:700,fontSize:22,color:m.c,marginTop:3}}>{m.v}</div>
                    <div style={{fontFamily:mono,fontSize:10,color:C.faint}}>{m.sub}</div>
                  </div>
                ))}
              </div>

              <Eyebrow>推奨オペレーション（自動生成）</Eyebrow>
              <div style={{display:"flex",flexWrap:"wrap",gap:7,margin:"9px 0 4px"}}>
                {[
                  {l:`給水 +${plan.water}`,on:true,c:C.cool},{l:`救護 +${plan.aid}`,on:true,c:C.safe},
                  {l:`誘導 +${plan.guide}`,on:true,c:C.caution},{l:"ミスト稼働",on:plan.mist,c:C.cool},
                  {l:"一方通行化",on:plan.oneway,c:C.busy},{l:"入退場制限を準備",on:plan.entryCtl,c:C.danger},
                  {l:"鉄道・警察と退場連携",on:plan.stationCoord,c:C.violet},
                ].filter(x=>x.on).map((x,i)=><Chip key={i} c={x.c}>{x.l}</Chip>)}
              </div>

              {/* 厚く置く→賢く置く */}
              <div style={{marginTop:14,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:12}}>
                <TrendingDown size={20} color={C.safe}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,color:C.muted}}>「厚く置く」→「賢く置く」（人時試算）</div>
                  <div style={{fontFamily:mono,fontSize:13,marginTop:2}}>
                    <span style={{color:C.faint,textDecoration:"line-through"}}>{plan.baselinePH}人時</span>
                    <span style={{color:C.faint}}> → </span>
                    <span style={{color:C.mist,fontWeight:700}}>{plan.optimizedPH}人時</span>
                    <span style={{color:C.safe,fontWeight:700}}>（-{plan.saved}%）</span>
                  </div>
                  <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:2}}>一律増員をやめ、ピーク時間帯・危険エリアに集中配置した場合</div>
                </div>
              </div>

              <button onClick={()=>setShowPlan(v=>!v)}
                style={{marginTop:14,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                  padding:"12px 0",borderRadius:11,cursor:"pointer",fontWeight:700,fontSize:14,
                  background:C.cool,color:C.ink,border:"none"}}>
                <FileText size={17}/>{showPlan?"計画書を閉じる":"雑踏警備計画書＋配置図をワンクリック出力"}
              </button>
              {showPlan&&<PlanDoc s={s} plan={plan}/>}
            </Panel>

            {/* --- map --- */}
            <Panel style={{padding:18}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:10}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                    <MapPin size={15} color={C.cool}/><Eyebrow>{scope==="in"?"会場内予報 × 暑熱予報":"会場外予報 ── 駅動線・路地"}</Eyebrow></div>
                  <div style={{fontWeight:600,fontSize:16}}>{hour}:00 の予測</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{display:"flex",gap:4,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:10,padding:3}}>
                    {[["in","会場内"],["out","会場外"]].map(([k,l])=>(
                      <button key={k} onClick={()=>setScope(k)}
                        style={{padding:"6px 11px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,
                          background:scope===k?C.violet:"transparent",color:scope===k?C.ink:C.muted,border:"none"}}>{l}</button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:4,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:10,padding:3}}>
                    {[["crowd","混雑"],["heat","暑熱/日陰"]].map(([k,l])=>(
                      <button key={k} onClick={()=>setLayer(k)}
                        style={{padding:"6px 11px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,
                          background:layer===k?C.cool:"transparent",color:layer===k?C.ink:C.muted,border:"none"}}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>

              <ZoneMap zones={zones} hour={hour} s={s} layer={layer}/>

              <div style={{display:"flex",alignItems:"center",gap:14,marginTop:12}}>
                <SunArc hour={hour} s={s}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontFamily:mono,fontSize:10,color:C.faint,marginBottom:6}}>
                    <span>開場 {OPEN}:00</span><span>時間スクラバー</span><span>終演 {CLOSE}:00</span></div>
                  <input type="range" min={OPEN} max={CLOSE} value={hour} onChange={e=>setHour(+e.target.value)} style={{width:"100%"}}/>
                </div>
              </div>
              <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:6}}>
                ☂ = その時間帯に日陰。厳密な影形状・日陰率は「暑熱エンジン」タブ（同一の太陽位置・WBGTモデル）で確認。
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:12}}>
                <div style={{background:C.panel2,border:`1px solid ${densStyle(now.maxD).c}44`,borderRadius:11,padding:"10px 12px"}}>
                  <div style={{fontSize:11,color:C.muted,display:"flex",gap:6,alignItems:"center"}}><Users size={13} color={densStyle(now.maxD).c}/>最混雑</div>
                  <div style={{fontWeight:700,fontSize:14,marginTop:3,color:densStyle(now.maxD).c}}>{now.maxDZ.name}・{densStyle(now.maxD).label}</div>
                </div>
                <div style={{background:C.panel2,border:`1px solid ${heatStyle(now.maxW).c}44`,borderRadius:11,padding:"10px 12px"}}>
                  <div style={{fontSize:11,color:C.muted,display:"flex",gap:6,alignItems:"center"}}><Thermometer size={13} color={heatStyle(now.maxW).c}/>最暑熱</div>
                  <div style={{fontWeight:700,fontSize:14,marginTop:3,color:heatStyle(now.maxW).c}}>{now.maxWZ.name}・{heatStyle(now.maxW).label}</div>
                </div>
              </div>
              {scope==="out"&&(
                <div style={{marginTop:10,fontFamily:mono,fontSize:11,color:C.muted,lineHeight:1.7,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:10,padding:"10px 12px"}}>
                  会場外予報：開場前（{OPEN}:00）は駅→ゲートの流入、終演後（{CLOSE-1}:00〜）は路地・ホームへの逆流が詰まりの主因。
                  {plan.outDanger?" 本シナリオでは商店街の路地が危険密度に達するため、鉄道事業者・警察との退場連携を推奨。":" 本シナリオでは許容範囲。"}
                </div>
              )}
            </Panel>
          </div>
        </>)}

        {view==="shade"&&<ShadeView s={s} setS={setS} t={t} setT={setT}/>}
        {view==="app"&&<VisitorApp s={s} hour={hour} setHour={setHour} plan={plan}/>}
        {view==="ai"&&<AIView s={s} plan={plan}/>}
        {view==="data"&&<DataView/>}

        <div style={{marginTop:22,display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",justifyContent:"space-between",fontFamily:mono,fontSize:11,color:C.faint}}>
          <span style={{display:"flex",alignItems:"center",gap:6}}><Shield size={13} color={C.faint}/>事故ゼロと、最高の体験は、両立できる。</span>
          <span>CROWD WEATHER ｜ 統合プロトタイプ v3 ｜ 混雑予報 × 暑熱エンジン × OrcaRouter</span>
        </div>
      </div>
    </div>
  );
}

/* ---- 計画書＋配置図（暑熱エンジンのタープ提案を統合） ---- */
function PlanDoc({ s, plan }) {
  const wLabel=s.weather==="sunny"?"晴":s.weather==="cloudy"?"曇":"雨";
  const steps=useMemo(()=>computeDay(s.date,envOf(s)),[s]);
  const tp=useMemo(()=>tentPlan(steps),[steps]);
  const ops=[`給水スタッフ +${plan.water}`,`救護スタッフ +${plan.aid}`,`誘導スタッフ +${plan.guide}`,
    plan.mist?"ミスト稼働":null,plan.oneway?"南通路 一方通行化":null,
    plan.entryCtl?"入退場制限の準備":null,plan.stationCoord?"鉄道事業者・警察と退場時連携":null].filter(Boolean);
  const dots=staffDots(s,plan);
  return (
    <div style={{marginTop:14,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:12,padding:16,fontFamily:mono}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:700,color:C.mist}}>雑踏警備計画書（自動生成・抜粋）</div>
        <div style={{fontSize:10,color:C.faint}}>DRAFT ／ 警察届出・社内稟議フォーマット準拠</div>
      </div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11.5}}>
        <tbody style={{color:C.muted}}>
          {[
            ["予報シナリオ",`${wLabel}・${s.temp}℃・湿度${s.RH}%・風${s.v}m/s ／ 来場規模 ${s.tickets.toLocaleString()}`],
            ["最大混雑",`混雑指数 ${plan.peakD}（${plan.peakDH}:00 ${plan.peakDZ.name}）／ 待機列 約${plan.waitMin}分`],
            ["暑熱リスク",`WBGT ${plan.peakW}（${heatStyle(plan.peakW).label}）／ ${plan.peakWH}:00 前後がピーク（NOAA×日射モデル実計算）`],
            ["推奨配置",ops.join(" ／ ")],
            ["暑熱対策",tp.total>0?`可搬タープ ${tp.total}張（${tp.list.map(p=>`${p.zone.name}${p.need}`).join("・")}）── 影計算エンジン算出`:"建物日陰で基準を満たす（追加日除け不要）"],
            ["会場外",plan.outDanger?"終演後、商店街路地・駅ホームに危険密度。整列退場と時差退場アナウンスを実施。":"駅動線は許容範囲。通常巡回。"],
            ["特記",plan.corridorDanger?"退場動線に危険密度。入退場制限・整列退場を準備。":"現配置で許容範囲。ピーク時間帯の巡回を強化。"],
          ].map(([k,v],i)=>(
            <tr key={i} style={{borderTop:i?`1px solid ${C.line}`:"none"}}>
              <td style={{padding:"8px 10px 8px 0",color:C.faint,whiteSpace:"nowrap",verticalAlign:"top",width:92}}>{k}</td>
              <td style={{padding:"8px 0",color:C.mist,lineHeight:1.6}}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{marginTop:12}}>
        <div style={{fontSize:11,color:C.faint,marginBottom:6}}>配置図（ピーク {plan.peakDH}:00 時点・自動生成）</div>
        <ZoneMap zones={IN_ZONES} hour={plan.peakDH} s={s} layer="crowd" height={170} mini staff={dots}/>
        <div style={{display:"flex",gap:12,marginTop:7,fontSize:10,color:C.faint}}>
          <span><i style={{display:"inline-block",width:9,height:9,borderRadius:99,background:C.cool,marginRight:4}}/>給水</span>
          <span><i style={{display:"inline-block",width:9,height:9,borderRadius:99,background:C.caution,marginRight:4}}/>誘導</span>
          <span><i style={{display:"inline-block",width:9,height:9,borderRadius:99,background:C.safe,marginRight:4}}/>救護</span>
        </div>
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.faint,display:"flex",alignItems:"center",gap:6}}>
        <ChevronRight size={12} color={C.faint}/>文章化はAIレイヤー（OrcaRouter経由）で自動生成。時間帯別シフト表・PDF出力に対応（本デモは抜粋）。
      </div>
    </div>
  );
}

/* ---- 来場者アプリ（スマホモック） ---- */
function VisitorApp({ s, hour, setHour, plan }) {
  const [tab,setTab]=useState("nav");
  const advice=gateAdvice(hour,s);
  const inStats=hourStats(IN_ZONES,hour,s);
  const shadedNow=IN_ZONES.filter(z=>isShaded(z,hour));
  const shadeRate=Math.round(shadedNow.length/IN_ZONES.length*100);
  const aidD=density(IN_ZONES.find(z=>z.id==="aid"),hour,s);
  const alertOn=inStats.maxD>=75||inStats.maxW>=31;
  return (
    <div className="cw-grid" style={{display:"grid",gridTemplateColumns:"minmax(0,380px) minmax(0,1fr)",gap:16,justifyContent:"center"}}>
      {/* phone */}
      <div style={{background:C.panel,border:`1px solid ${C.line}`,borderRadius:28,padding:12,maxWidth:380,margin:"0 auto",width:"100%"}}>
        <div style={{background:C.deep,borderRadius:20,overflow:"hidden",border:`1px solid ${C.line}`}}>
          {/* status */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",borderBottom:`1px solid ${C.line}`}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}>
              <Cloud size={17} color={C.cool}/><span style={{fontWeight:700,fontSize:13}}>CROWD WEATHER</span></div>
            <div style={{fontFamily:mono,fontSize:12,color:C.muted}}>{hour}:00 ・ <WeatherIcon w={s.weather} size={12} color={C.muted}/> {s.temp}℃</div>
          </div>
          {/* push alert */}
          {alertOn&&(
            <div style={{margin:"12px 14px 0",background:C.danger+"1A",border:`1px solid ${C.danger}55`,borderRadius:12,padding:"10px 12px",display:"flex",gap:9}}>
              <Bell size={15} color={C.danger} style={{flexShrink:0,marginTop:1}}/>
              <div style={{fontSize:11.5,lineHeight:1.55,color:C.mist}}>
                {inStats.maxD>=75?`${plan.peakDH}:00 頃 ${plan.peakDZ.name}周辺が危険密度の予報。`:""}
                {inStats.maxW>=31?`現在 ${inStats.maxWZ.name}は暑熱危険。日陰側へ。`:""}
                <span style={{color:C.cool}}> 空いているルートを見る →</span>
              </div>
            </div>
          )}
          {/* tabs */}
          <div style={{display:"flex",gap:4,padding:"12px 14px 0"}}>
            {[["nav","分散ナビ",<Navigation key="n" size={13}/>],["shade","日陰ルート",<Umbrella key="s" size={13}/>],["help","こまりごと",<LifeBuoy key="h" size={13}/>]].map(([k,l,ic])=>(
              <button key={k} onClick={()=>setTab(k)}
                style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,padding:"8px 0",
                  borderRadius:9,cursor:"pointer",fontSize:11.5,fontWeight:600,border:"none",
                  background:tab===k?C.cool:C.panel2,color:tab===k?C.ink:C.muted}}>{ic}{l}</button>
            ))}
          </div>
          {/* body */}
          <div style={{padding:14}}>
            {tab==="nav"&&(<>
              <div style={{fontSize:12.5,fontWeight:700,marginBottom:9}}>ピークそのものを、崩す。</div>
              <div style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:12,marginBottom:9}}>
                <div style={{fontSize:11,color:C.muted}}>いま入場するなら</div>
                <div style={{fontWeight:700,fontSize:15,marginTop:2}}>{advice.nowBest.g.name} <span style={{fontFamily:mono,color:densStyle(density(advice.nowBest.g,hour,s)).c}}>約{advice.nowBest.wait}分待ち</span></div>
              </div>
              {advice.shift&&advice.shift.wait<advice.nowBest.wait-4&&(
                <div style={{background:C.safe+"14",border:`1px solid ${C.safe}44`,borderRadius:12,padding:12,marginBottom:9}}>
                  <div style={{fontSize:11,color:C.safe,fontWeight:700}}>おすすめ：時間をずらす</div>
                  <div style={{fontSize:12.5,marginTop:3,lineHeight:1.6}}>{advice.shift.h}:00 の{advice.shift.g.name}なら <b style={{fontFamily:mono}}>約{advice.shift.wait}分</b>。それまで駅ナカで涼しく待つのが正解。</div>
                </div>
              )}
              <div style={{fontFamily:mono,fontSize:10.5,color:C.faint,lineHeight:1.7}}>帰路：{CLOSE-1}:00〜 は駅ホームが最混雑。終演15分前退場 or 30分の余韻で回避。GPSログは匿名化のうえ予報精度向上に利用。</div>
            </>)}
            {tab==="shade"&&(<>
              <div style={{fontSize:12.5,fontWeight:700,marginBottom:9}}>待つなら、涼しい側で。</div>
              <ZoneMap zones={IN_ZONES} hour={hour} s={s} layer="heat" height={165} mini highlightShade/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:9}}>
                <div style={{fontFamily:mono,fontSize:11,color:C.muted}}>現在の日陰カバー率 <b style={{color:C.cool}}>{shadeRate}%</b></div>
                <div style={{fontFamily:mono,fontSize:10,color:C.faint}}>☂ = 日陰</div>
              </div>
              <div style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:11,marginTop:9,fontSize:12,lineHeight:1.65}}>
                {hour<=13?"午前は東側建物の影。物販の列は東ゲート側から並ぶのが涼しい。":hour<16?"日陰が最少の時間帯。屋内サブステージ・救護所を退避先に。":"夕方は西側に影が伸びる。西ゲート・フードコート側が涼しい。"}
              </div>
            </>)}
            {tab==="help"&&(<>
              <div style={{fontSize:12.5,fontWeight:700,marginBottom:9}}>要配慮者を、先に守る。</div>
              {[
                {ic:<Droplets size={15} color={C.cool}/>,t:"給水所",d:`救護・給水エリアまで徒歩3分。現在の混雑 ${aidD}（${densStyle(aidD).label}）`},
                {ic:<LifeBuoy size={15} color={C.safe}/>,t:"救護所",d:"体調不良の予兆段階で案内。スタッフ側にも同時通知され、先回りで動ける。"},
                {ic:<Users size={15} color={C.violet}/>,t:"ベビーカー優先動線",d:"段差なし・日陰率の高いルートを常時表示。混雑ピーク時は専用退場口へ。"},
              ].map((f,i)=>(
                <div key={i} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:11,marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,fontWeight:700,fontSize:12.5}}>{f.ic}{f.t}</div>
                  <div style={{fontSize:11.5,color:C.muted,marginTop:4,lineHeight:1.6}}>{f.d}</div>
                </div>
              ))}
              <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:4,lineHeight:1.6}}>
                こまりごとの自由入力チャットは、AIレイヤー（OrcaRouter経由）で軽量モデルに自動ルーティング。
              </div>
            </>)}
          </div>
        </div>
      </div>
      {/* side note */}
      <Panel style={{padding:18,alignSelf:"start"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Smartphone size={15} color={C.cool}/><Eyebrow>Product 02 ── 来場者アプリ（無料）</Eyebrow></div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:12}}>いちばん暑い場所に、いちばん困っている人がいる。</div>
        <div style={{fontSize:13,color:C.muted,lineHeight:1.8,marginBottom:14}}>
          来場者アプリは無料。天気予報を見て傘をさすように、混雑予報を見て入場時間とルートを変える——その行動変容そのものがピークを崩し、事故リスクを下げる。利用ログは実測データとして予報精度を押し上げ、導入イベントが増えるほど強くなる。
        </div>
        <div style={{fontFamily:mono,fontSize:11,color:C.faint,marginBottom:10}}>時間を動かして、提案の変化を確認：</div>
        <input type="range" min={OPEN} max={CLOSE} value={hour} onChange={e=>setHour(+e.target.value)} style={{width:"100%"}}/>
        <div style={{display:"flex",justifyContent:"space-between",fontFamily:mono,fontSize:10,color:C.faint,marginTop:5}}>
          <span>{OPEN}:00</span><span style={{color:C.cool}}>{hour}:00</span><span>{CLOSE}:00</span></div>
        <div style={{marginTop:14,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:11,padding:"11px 13px",fontFamily:mono,fontSize:11,color:C.muted,lineHeight:1.7}}>
          主催者コンソールと同じ予測モデルに連動。運営の打ち手（供給側）と来場者の行動（需要側）を、ひとつの予報で同時に動かす。
        </div>
      </Panel>
    </div>
  );
}

/* ---- データ設計 ---- */
function DataView() {
  const open=[
    {n:"人流統計",src:"東京データプラットフォーム",feeds:["混雑"]},
    {n:"道路ネットワーク・幅員",src:"東京都オープンデータ",feeds:["混雑"]},
    {n:"駅別乗降者数",src:"東京都・各鉄道",feeds:["混雑"]},
    {n:"3D都市モデル（建物形状）",src:"PLATEAU",feeds:["暑熱"]},
    {n:"暑さ指数・気象データ",src:"環境省・気象庁",feeds:["暑熱"]},
    {n:"イベント情報・クールスポット",src:"東京都オープンデータ",feeds:["混雑","暑熱"]},
  ];
  const priv=[
    {n:"チケット販売数",src:"主催者",feeds:["混雑"],note:"来場規模の最重要変数"},
    {n:"入退場ゲートログ・場内売上",src:"主催者",feeds:["混雑"]},
    {n:"Wi-Fi／ビーコン滞留実測",src:"自社センシング",feeds:["混雑"]},
    {n:"カメラ人流センシング",src:"自社センシング",feeds:["混雑","暑熱"]},
    {n:"来場者アプリ利用ログ",src:"CROWD WEATHER",feeds:["混雑","暑熱"],note:"予報精度を押し上げる実測"},
  ];
  const Feed=({f})=><span style={{fontFamily:mono,fontSize:10,color:f==="混雑"?C.busy:C.heat,background:(f==="混雑"?C.busy:C.heat)+"1A",border:`1px solid ${(f==="混雑"?C.busy:C.heat)}44`,borderRadius:99,padding:"2px 8px"}}>→{f}予測</span>;
  const Card=({d})=>(
    <div style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:"12px 14px"}}>
      <div style={{fontWeight:700,fontSize:13}}>{d.n}</div>
      <div style={{fontFamily:mono,fontSize:10.5,color:C.faint,margin:"3px 0 7px"}}>{d.src}{d.note?` ── ${d.note}`:""}</div>
      <div style={{display:"flex",gap:6}}>{d.feeds.map(f=><Feed key={f} f={f}/>)}</div>
    </div>
  );
  return (
    <div className="cw-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <Panel style={{padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Database size={15} color={C.cool}/><Eyebrow>東京都オープンデータ 等</Eyebrow></div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:14}}>誰でも使える「土台」</div>
        <div style={{display:"grid",gap:10}}>{open.map((d,i)=><Card key={i} d={d}/>)}</div>
        <div style={{marginTop:12,fontFamily:mono,fontSize:10.5,color:C.faint,lineHeight:1.7}}>
          ※ 3D都市モデルの活用は、2024年度都知事杯受賞作「高解像度熱中症リスクマップ」の系譜。本プロトタイプの暑熱エンジンはNOAA太陽位置×影投影×WBGTの実計算。
        </div>
      </Panel>
      <Panel style={{padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Zap size={15} color={C.caution}/><Eyebrow>民間 × 自社データ</Eyebrow></div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:14}}>私たちしか持ち込めない「差」</div>
        <div style={{display:"grid",gap:10}}>{priv.map((d,i)=><Card key={i} d={d}/>)}</div>
        <div style={{marginTop:12,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:11,padding:"11px 13px",display:"flex",gap:9}}>
          <Lock size={14} color={C.caution} style={{flexShrink:0,marginTop:2}}/>
          <div style={{fontSize:12,color:C.muted,lineHeight:1.7}}>
            民間イベントデータは、主催者との信頼関係がなければ集まらない。イベント制作の当事者である私たち自身が「データの持ち込み手」——ここが最大の参入障壁になる。
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   SHADE VIEW ── 暑熱予報エンジン（統合版：環境条件は全タブ共有）
   ============================================================ */
function ShadeView({ s, setS, t, setT }) {
  const [playing,setPlaying] = useState(false);
  const [showTents,setShowTents] = useState(false);
  const [selZone,setSelZone] = useState("wg");

  const env = envOf(s);
  const date = s.date;
  const setE = (k,v)=>setS(p=>({...p,[k]:v}));
  const setDate = d=>setS(p=>({...p,date:d}));

  const steps = useMemo(()=>computeDay(date,env),[date,env.weather,env.Ta,env.RH,env.v]);
  const tp    = useMemo(()=>tentPlan(steps),[steps]);

  const sun = useMemo(()=>sunPosition(date.y,date.mo,date.d,t),[date,t]);
  const night = sun.alt <= 0.5;
  const shadows = useMemo(()=> night ? [] :
    BUILDINGS.map(b=>shadowPolygon(rectPoly(b.rect), b.h, sun.alt, sun.az)),[sun,night]);
  const zoneNow = useMemo(()=>SZONES.map(z=>{
    const sf = night ? 1 : shadeRatio(z.rect, shadows);
    const { wbgt, S } = wbgtAt(sf, Math.max(sun.alt,0), env);
    return { ...z, shade:sf, wbgt, S };
  }),[shadows,sun,env.weather,env.Ta,env.RH,env.v,night]);

  useEffect(()=>{
    if(!playing) return;
    const id = setInterval(()=>setT(t>=CLOSE_M?OPEN_M:Math.min(CLOSE_M,t+10)),120);
    return ()=>clearInterval(id);
  },[playing,t,setT]);

  // 建物で守れない時間帯（敷地日陰率が低く WBGT が厳重警戒以上）
  const gap = useMemo(()=>{
    const bad = steps.filter(st=>!st.night && st.siteShade<0.25 &&
      wbgtAt(0,st.sun.alt,env).wbgt>=28);
    if(!bad.length) return null;
    const avg = bad.reduce((a,b)=>a+b.siteShade,0)/bad.length;
    return { from:bad[0].m, to:bad[bad.length-1].m+30, avg };
  },[steps,env.weather,env.Ta,env.RH,env.v]);

  return (
    <div>
      {/* 見出しの発見 */}
      {gap && (
        <div style={{background:C.heat+"14",border:`1px solid ${C.heat}55`,borderRadius:14,padding:"14px 16px",
          display:"flex",gap:12,alignItems:"flex-start",margin:"0 0 16px"}}>
          <AlertTriangle size={20} color={C.heat} style={{flexShrink:0,marginTop:2}}/>
          <div>
            <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>
              {fmt(gap.from)}–{fmt(gap.to)}、敷地の日陰率は平均 {Math.round(gap.avg*100)}%。建物では守れない。
            </div>
            <div style={{fontSize:12.5,color:C.muted,lineHeight:1.7}}>
              太陽高度が高い時間帯は影が伸びない（{date.mo}/{date.d} の南中で40m建物の影長は約{
                (40/Math.tan(Math.max(...steps.map(st=>st.sun.alt))*RAD)).toFixed(0)}m）。
              WBGTがピークを迎える時間と、建物日陰が消える時間が完全に重なる。可搬日除けの事前配置が唯一の解になる。
            </div>
          </div>
        </div>
      )}

      <div className="cw-grid" style={{display:"grid",gridTemplateColumns:"minmax(0,1.35fr) minmax(0,1fr)",gap:16}}>

        {/* ---------- 左：マップ ---------- */}
        <Panel style={{padding:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:12}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <Layers size={15} color={C.cool}/><Eyebrow>Shadow Map ── 実影計算</Eyebrow></div>
              <div style={{fontWeight:600,fontSize:16}}>{fmt(t)} の日陰</div>
              <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:2}}>東京 {LAT}°N {LON}°E ／ NOAA太陽位置 × 影投影 × WBGT（0.7Tnw+0.2Tg+0.1Ta）</div>
            </div>
            <button onClick={()=>setShowTents(v=>!v)}
              style={{display:"flex",alignItems:"center",gap:6,padding:"8px 13px",borderRadius:10,cursor:"pointer",
                fontSize:12.5,fontWeight:600,border:`1px solid ${showTents?C.violet:C.line}`,
                background:showTents?C.violet:"transparent",color:showTents?C.ink:C.muted}}>
              <Tent size={14}/>テント提案を重ねる
            </button>
          </div>

          <ShadowCanvas sun={sun} night={night} shadows={shadows} zoneNow={zoneNow}
            showTents={showTents} plan={tp} selZone={selZone} onSelect={setSelZone}/>

          {/* time control */}
          <div style={{display:"flex",alignItems:"center",gap:12,marginTop:14}}>
            <button onClick={()=>setPlaying(p=>!p)}
              style={{width:40,height:40,borderRadius:12,border:"none",cursor:"pointer",
                background:playing?C.violet:C.cool,color:C.ink,display:"grid",placeItems:"center",flexShrink:0}}>
              {playing?<Pause size={18}/>:<Play size={18}/>}
            </button>
            <div style={{flex:1}}>
              <input type="range" min={OPEN_M} max={CLOSE_M} step={10} value={t}
                onChange={e=>{setPlaying(false);setT(+e.target.value);}} style={{width:"100%"}}/>
              <div style={{display:"flex",justifyContent:"space-between",fontFamily:mono,fontSize:10,color:C.faint,marginTop:5}}>
                <span>{fmt(OPEN_M)}</span><span style={{color:C.cool}}>{fmt(t)}</span><span>{fmt(CLOSE_M)}</span>
              </div>
            </div>
          </div>

          {/* sun readout */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:9,marginTop:12}}>
            {[
              { k:"太陽高度", v: night?"日没":`${sun.alt.toFixed(1)}°`, c: night?C.faint:C.caution },
              { k:"太陽方位", v: night?"—":`${sun.az.toFixed(0)}°`, c: C.muted },
              { k:"40m建物の影長", v: night?"—":`${Math.min(999,40/Math.tan(sun.alt*RAD)).toFixed(0)}m`, c: C.cool },
              { k:"敷地日陰率", v: `${Math.round((steps.find(st=>st.m===Math.round(t/30)*30)?.siteShade??0)*100)}%`, c: C.violet },
            ].map(m=>(
              <div key={m.k} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:11,padding:"9px 11px"}}>
                <div style={{fontSize:10.5,color:C.faint}}>{m.k}</div>
                <div style={{fontFamily:mono,fontWeight:700,fontSize:16,color:m.c,marginTop:2}}>{m.v}</div>
              </div>
            ))}
          </div>
        </Panel>

        {/* ---------- 右：条件 ---------- */}
        <Panel style={{padding:18,alignSelf:"start"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <Compass size={15} color={C.cool}/><Eyebrow>Conditions ── 計算条件（全タブ共有）</Eyebrow></div>

          <div style={{fontSize:12,color:C.muted,marginBottom:7}}>開催日（太陽赤緯が変わる）</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:16}}>
            {[
              {y:2026,mo:6,d:21,label:"6/21 夏至"},
              {y:2026,mo:8,d:8, label:"8/8 真夏"},
              {y:2026,mo:9,d:23,label:"9/23 秋分"},
              {y:2026,mo:5,d:5, label:"5/5 GW"},
            ].map(dd=>(
              <button key={dd.label} onClick={()=>setDate({...dd,label:dd.label})}
                style={{padding:"9px 0",borderRadius:10,cursor:"pointer",fontSize:12.5,fontWeight:600,
                  border:`1px solid ${date.mo===dd.mo&&date.d===dd.d?C.cool:C.line}`,
                  background:date.mo===dd.mo&&date.d===dd.d?C.cool:C.panel2,
                  color:date.mo===dd.mo&&date.d===dd.d?C.ink:C.muted}}>{dd.label}</button>
            ))}
          </div>

          <div style={{fontSize:12,color:C.muted,marginBottom:7}}>天候</div>
          <div style={{display:"flex",gap:7,marginBottom:16}}>
            {[["sunny","晴",Sun],["cloudy","曇",Cloud],["rainy","雨",CloudRain]].map(([k,l,Ic])=>(
              <button key={k} onClick={()=>setE("weather",k)}
                style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"9px 0",
                  borderRadius:10,cursor:"pointer",fontWeight:600,fontSize:13,
                  border:`1px solid ${env.weather===k?C.cool:C.line}`,
                  background:env.weather===k?C.cool:C.panel2,color:env.weather===k?C.ink:C.muted}}>
                <Ic size={15}/>{l}</button>
            ))}
          </div>

          {[
            { k:"temp", ek:"Ta", icon:<Thermometer size={13} color={C.heat}/>, label:"気温", min:22, max:39, step:1, unit:"℃" },
            { k:"RH", ek:"RH", icon:<Droplets size={13} color={C.cool}/>,    label:"相対湿度", min:30, max:95, step:5, unit:"%" },
            { k:"v", ek:"v",  icon:<Wind size={13} color={C.muted}/>,       label:"風速", min:0.2, max:5, step:0.1, unit:"m/s" },
          ].map(f=>(
            <div key={f.k} style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:12,color:C.muted,display:"flex",alignItems:"center",gap:6}}>{f.icon}{f.label}</span>
                <span style={{fontFamily:mono,fontWeight:600}}>{env[f.ek]}{f.unit}</span>
              </div>
              <input type="range" min={f.min} max={f.max} step={f.step} value={env[f.ek]}
                onChange={e=>setE(f.k,+e.target.value)} style={{width:"100%"}}/>
            </div>
          ))}

          {/* 日向 vs 日陰 */}
          <div style={{marginTop:6,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:"12px 14px"}}>
            <div style={{fontFamily:mono,fontSize:10.5,color:C.faint,marginBottom:8}}>{fmt(t)} 時点の実効WBGT</div>
            {[["日向",0],["日陰",1]].map(([l,sf])=>{
              const r = wbgtAt(sf,Math.max(sun.alt,0),env), st = wbgtStyle(r.wbgt);
              return (
                <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0"}}>
                  <span style={{fontSize:12.5,color:C.muted}}>{l}<span style={{fontFamily:mono,fontSize:10,color:C.faint}}> ／ 日射 {r.S.toFixed(0)}W/㎡</span></span>
                  <span style={{fontFamily:mono,fontWeight:700,fontSize:15,color:st.c}}>{r.wbgt.toFixed(1)} <span style={{fontSize:11}}>{st.label}</span></span>
                </div>
              );
            })}
            <div style={{borderTop:`1px solid ${C.line}`,marginTop:8,paddingTop:8,fontFamily:mono,fontSize:11,color:C.cool}}>
              日陰に入るだけで −{(wbgtAt(0,Math.max(sun.alt,0),env).wbgt - wbgtAt(1,Math.max(sun.alt,0),env).wbgt).toFixed(1)}℃
            </div>
          </div>
          <div style={{marginTop:12,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:11,padding:"10px 12px",fontSize:11,color:C.muted,lineHeight:1.7}}>
            ここで動かした条件は主催者コンソール・来場者アプリ・AIレイヤーにもそのまま反映される。
          </div>
        </Panel>
      </div>

      {/* ---------- 日照タイムライン ---------- */}
      <Panel style={{padding:18,marginTop:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",flexWrap:"wrap",gap:8,marginBottom:14}}>
          <div>
            <Eyebrow>Zone Timeline ── ゾーン別 日陰率 × WBGT</Eyebrow>
            <div style={{fontWeight:600,fontSize:15,marginTop:3}}>どこが、いつ、危険になるか</div>
          </div>
          <div style={{display:"flex",gap:12,fontFamily:mono,fontSize:10,color:C.faint,flexWrap:"wrap"}}>
            {[["注意",C.safe],["警戒",C.caution],["厳重警戒",C.busy],["危険",C.heat]].map(([l,c])=>(
              <span key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                <i style={{width:9,height:9,background:c,borderRadius:2,display:"inline-block"}}/>{l}</span>
            ))}
            <span>／ 縦線 = 日陰率</span>
          </div>
        </div>
        <Timeline steps={steps} t={t} onPick={setT} selZone={selZone} onSelect={setSelZone}/>
      </Panel>

      {/* ---------- テント配置提案 ---------- */}
      <Panel style={{padding:18,marginTop:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Tent size={15} color={C.violet}/><Eyebrow>Output ── 可搬日除けの配置提案</Eyebrow></div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:4}}>
          {tp.total>0 ? `${tp.total}張のタープで、危険時間帯の待機列を守れる。` : "この条件では、追加の日除けなしで基準を満たす。"}
        </div>
        <div style={{fontSize:12,color:C.muted,marginBottom:14,lineHeight:1.7}}>
          WBGT 28以上（厳重警戒）かつ日陰率60%未満の待機帯を抽出し、3m×6m（{TENT}㎡）タープ換算で必要数を算出。この結果は主催者コンソールの雑踏警備計画書「暑熱対策」欄に自動転記される。
        </div>
        {tp.list.length>0 ? (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))",gap:11}}>
            {tp.list.map(p=>{
              const st = wbgtStyle(p.wbgt);
              return (
                <div key={p.zone.id} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:13}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                    <span style={{fontWeight:700,fontSize:14}}>{p.zone.name}</span>
                    <span style={{fontFamily:mono,fontWeight:700,fontSize:19,color:C.violet}}>{p.need}<span style={{fontSize:11,color:C.muted}}>張</span></span>
                  </div>
                  <div style={{fontFamily:mono,fontSize:11,color:C.muted,lineHeight:1.8}}>
                    必要時間帯　{fmt(p.from)}–{fmt(p.to)}<br/>
                    最悪時　日陰率 {Math.round(p.shade*100)}% ／ <span style={{color:st.c}}>WBGT {p.wbgt.toFixed(1)} {st.label}</span><br/>
                    対象　{p.zone.kind}・待機帯 {p.zone.queueArea}㎡
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{fontFamily:mono,fontSize:12,color:C.faint,background:C.panel2,border:`1px dashed ${C.line}`,borderRadius:12,padding:14}}>
            気温・湿度・天候を上げると、必要枚数が算出されます。
          </div>
        )}
      </Panel>

      {/* ---------- データ出典 ---------- */}
      <Panel style={{padding:18,marginTop:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          <Building2 size={15} color={C.cool}/><Eyebrow>Data Binding ── 実データ接続点</Eyebrow></div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(250px,1fr))",gap:11}}>
          {[
            { t:"建物形状・高さ", s:"PLATEAU 3D都市モデル",
              d:"bldg:Building の lod0FootPrint（底面ポリゴン）と bldg:measuredHeight を平面直角座標系に変換し、本エンジンの footprint / height にそのまま投入できる。" },
            { t:"気温・湿度・風速", s:"気象庁 アメダス",
              d:"WBGT式の Ta / RH / v に対応。予報値を入れれば、当日ではなく事前の計画段階で暑熱リスクが確定する。" },
            { t:"暑さ指数（実況・予測）", s:"環境省 熱中症予防情報サイト",
              d:"地点WBGTの実測。本エンジンの計算値をキャリブレーションし、地点値→会場内メッシュ値へ空間補間する。" },
            { t:"クールスポット・給水",  s:"東京都オープンデータ",
              d:"算出した日陰不足エリアと突き合わせ、既存の涼み場所で足りるか／可搬日除けが要るかを判定する。" },
          ].map((d,i)=>(
            <div key={i} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:13}}>
              <div style={{fontWeight:700,fontSize:13}}>{d.t}</div>
              <div style={{fontFamily:mono,fontSize:10.5,color:C.cool,margin:"3px 0 7px"}}>{d.s}</div>
              <div style={{fontSize:11.5,color:C.muted,lineHeight:1.7}}>{d.d}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:12,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:11,padding:"11px 13px",display:"flex",gap:9}}>
          <Info size={14} color={C.faint} style={{flexShrink:0,marginTop:2}}/>
          <div style={{fontSize:11.5,color:C.muted,lineHeight:1.75}}>
            本デモの敷地・建物はダミー。太陽位置はNOAA式、影は footprint のミンコフスキー和（凸形状で厳密）、WBGTは Stull(2011) の湿球温度と黒球温度近似による実計算。
            検証：夏至の南中高度 77.8°（解析解 90−35.69+23.44 と一致）、日向・日陰のWBGT差 約4℃（実測文献の3〜5℃と整合）。
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ---------- Canvas ---------- */
function ShadowCanvas({ sun, night, shadows, zoneNow, showTents, plan, selZone, onSelect }){
  const ref = useRef(null);
  const W = 840, H = 630, PAD = 26;
  const sx = (W-PAD*2)/SITE.w, sy = (H-PAD*2)/SITE.h, S = Math.min(sx,sy);
  const px = x => PAD + x*S;
  const py = y => H - PAD - y*S;   // 北を上に

  useEffect(()=>{
    const cv = ref.current; if(!cv) return;
    const g = cv.getContext("2d");
    g.clearRect(0,0,W,H);

    // 地面
    g.fillStyle = night ? "#080D1A" : "#141D33";
    g.fillRect(0,0,W,H);
    // グリッド 20m
    g.strokeStyle = "#1A2440"; g.lineWidth = 1;
    for(let x=0;x<=SITE.w;x+=20){ g.beginPath(); g.moveTo(px(x),py(0)); g.lineTo(px(x),py(SITE.h)); g.stroke(); }
    for(let y=0;y<=SITE.h;y+=20){ g.beginPath(); g.moveTo(px(0),py(y)); g.lineTo(px(SITE.w),py(y)); g.stroke(); }

    // 影
    g.fillStyle = "rgba(8,14,30,0.82)";
    for(const sp of shadows){
      if(!sp) continue;
      g.beginPath(); sp.forEach(([x,y],i)=> i?g.lineTo(px(x),py(y)):g.moveTo(px(x),py(y)));
      g.closePath(); g.fill();
    }

    // ゾーン
    for(const z of zoneNow){
      const [x0,y0,x1,y1] = z.rect, st = wbgtStyle(z.wbgt);
      const X=px(x0), Y=py(y1), Wd=(x1-x0)*S, Ht=(y1-y0)*S;
      g.fillStyle = st.c + (z.id===selZone ? "42" : "22");
      g.fillRect(X,Y,Wd,Ht);
      g.strokeStyle = st.c; g.lineWidth = z.id===selZone?2.5:1.4;
      g.strokeRect(X,Y,Wd,Ht);
      g.fillStyle = "#E6EDFB"; g.font = "600 13px 'Space Grotesk',sans-serif";
      g.fillText(z.name, X+7, Y+18);
      g.fillStyle = st.c; g.font = "700 13px 'IBM Plex Mono',monospace";
      g.fillText(`${z.wbgt.toFixed(1)}`, X+7, Y+35);
      g.fillStyle = C.muted; g.font = "500 11px 'IBM Plex Mono',monospace";
      g.fillText(`日陰 ${Math.round(z.shade*100)}%`, X+7, Y+50);
    }

    // 建物
    for(const b of BUILDINGS){
      const [x0,y0,x1,y1] = b.rect;
      const X=px(x0), Y=py(y1), Wd=(x1-x0)*S, Ht=(y1-y0)*S;
      g.fillStyle = C.bldg; g.fillRect(X,Y,Wd,Ht);
      g.strokeStyle = "#48597A"; g.lineWidth = 1; g.strokeRect(X,Y,Wd,Ht);
      g.fillStyle = "#B7C4DE"; g.font = "600 11px 'Space Grotesk',sans-serif";
      g.fillText(b.name, X+6, Y+16);
      g.fillStyle = C.faint; g.font = "500 10px 'IBM Plex Mono',monospace";
      g.fillText(`H=${b.h}m`, X+6, Y+30);
    }

    // テント
    if(showTents){
      for(const p of plan.list){
        const [x0,y0,x1,y1] = p.zone.rect;
        const cx = px((x0+x1)/2), cy = py((y0+y1)/2);
        const n = Math.min(p.need, 6);
        for(let i=0;i<n;i++){
          const ang = (i/n)*Math.PI*2, r = 22;
          const tx = cx + Math.cos(ang)*r, ty = cy + Math.sin(ang)*r*0.6;
          g.beginPath(); g.moveTo(tx,ty-8); g.lineTo(tx+9,ty+6); g.lineTo(tx-9,ty+6); g.closePath();
          g.fillStyle = C.violet; g.fill();
          g.strokeStyle = C.ink; g.lineWidth = 1.5; g.stroke();
        }
        g.fillStyle = C.violet; g.font = "700 13px 'IBM Plex Mono',monospace";
        g.textAlign = "center"; g.fillText(`+${p.need}`, cx, cy+42); g.textAlign = "left";
      }
    }

    // 方位＋太陽
    const ox = W-72, oy = 66, R = 30;
    g.strokeStyle = C.line; g.lineWidth = 1.5;
    g.beginPath(); g.arc(ox,oy,R,0,Math.PI*2); g.stroke();
    g.fillStyle = C.faint; g.font = "600 10px 'IBM Plex Mono',monospace"; g.textAlign="center";
    g.fillText("N",ox,oy-R-6); g.fillText("S",ox,oy+R+13);
    g.fillText("E",ox+R+8,oy+4); g.fillText("W",ox-R-8,oy+4);
    if(!night){
      const a = sun.az*RAD;
      const sxp = ox + Math.sin(a)*R*0.72, syp = oy - Math.cos(a)*R*0.72;
      g.strokeStyle = C.caution; g.lineWidth = 2;
      g.beginPath(); g.moveTo(ox,oy); g.lineTo(sxp,syp); g.stroke();
      g.beginPath(); g.arc(sxp,syp,5.5,0,Math.PI*2); g.fillStyle = C.caution; g.fill();
      // 影方向
      g.strokeStyle = "#5C6A8C"; g.lineWidth = 1.5; g.setLineDash([3,3]);
      g.beginPath(); g.moveTo(ox,oy); g.lineTo(ox-Math.sin(a)*R*0.9, oy+Math.cos(a)*R*0.9); g.stroke();
      g.setLineDash([]);
    } else {
      g.fillStyle = C.faint; g.font="600 11px 'Space Grotesk',sans-serif"; g.fillText("日没後",ox,oy+4);
    }
    g.textAlign = "left";

    // スケールバー
    const bar = 50*S;
    g.strokeStyle = C.muted; g.lineWidth = 2;
    g.beginPath(); g.moveTo(PAD,H-12); g.lineTo(PAD+bar,H-12); g.stroke();
    g.fillStyle = C.muted; g.font = "500 10px 'IBM Plex Mono',monospace";
    g.fillText("50m", PAD+bar+7, H-8);
  },[sun,night,shadows,zoneNow,showTents,plan,selZone]);

  const click = e => {
    const r = ref.current.getBoundingClientRect();
    const mx = ((e.clientX-r.left)/r.width)*W, my = ((e.clientY-r.top)/r.height)*H;
    const wx = (mx-PAD)/S, wy = (H-PAD-my)/S;
    const z = SZONES.find(q=>wx>=q.rect[0]&&wx<=q.rect[2]&&wy>=q.rect[1]&&wy<=q.rect[3]);
    if(z) onSelect(z.id);
  };

  return <canvas ref={ref} width={W} height={H} onClick={click}
    style={{width:"100%",height:"auto",display:"block",borderRadius:12,border:`1px solid ${C.line}`,cursor:"pointer"}}/>;
}

/* ---------- Timeline ---------- */
function Timeline({ steps, t, onPick, selZone, onSelect }){
  const cols = steps.length;
  return (
    <div style={{overflowX:"auto"}}>
      <div style={{minWidth:640}}>
        {/* 時刻軸 */}
        <div style={{display:"grid",gridTemplateColumns:`128px repeat(${cols},1fr)`,gap:2,marginBottom:5}}>
          <div/>
          {steps.map(s=>(
            <div key={s.m} style={{fontFamily:mono,fontSize:9,color:s.m===t?C.cool:C.faint,textAlign:"center"}}>
              {s.m%60===0?`${s.m/60}`:""}
            </div>
          ))}
        </div>
        {SZONES.map(z=>(
          <div key={z.id} onClick={()=>onSelect(z.id)}
            style={{display:"grid",gridTemplateColumns:`128px repeat(${cols},1fr)`,gap:2,marginBottom:3,
              cursor:"pointer",background:z.id===selZone?C.panel2:"transparent",borderRadius:6,padding:"2px 0"}}>
            <div style={{fontSize:11.5,color:z.id===selZone?C.mist:C.muted,paddingLeft:6,display:"flex",alignItems:"center",
              fontWeight:z.id===selZone?700:400}}>{z.name}</div>
            {steps.map(s=>{
              const zs = s.zones.find(q=>q.id===z.id);
              const st = wbgtStyle(zs.wbgt);
              return (
                <div key={s.m} title={`${fmt(s.m)} WBGT ${zs.wbgt.toFixed(1)} / 日陰 ${Math.round(zs.shade*100)}%`}
                  onClick={e=>{e.stopPropagation();onPick(s.m);}}
                  style={{height:26,background:s.night?"#0C1424":st.c+"33",borderRadius:3,position:"relative",
                    outline:s.m===t?`1.5px solid ${C.cool}`:"none"}}>
                  <div style={{position:"absolute",bottom:0,left:0,right:0,height:`${zs.shade*100}%`,
                    background:s.night?"#1A2440":st.c,borderRadius:"0 0 3px 3px",transition:"height .2s"}}/>
                </div>
              );
            })}
          </div>
        ))}
        <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:8,paddingLeft:6}}>
          セルの色 = WBGT区分／塗りの高さ = 日陰率。クリックでその時刻へ。
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   AI VIEW ── OrcaRouter 統合レイヤー
   難易度グレーディング → モデル振り分け → コスト最適化
   ============================================================ */
const AI_MODELS = {
  frontier: { name:"claude-sonnet 級",  tier:"フロンティア", pin:3.00, pout:15.00, c:C.violet },
  mid:      { name:"gemini-flash 級",   tier:"ミッドレンジ", pin:0.30, pout:2.50,  c:C.cool },
  cheap:    { name:"qwen-72b 級（OSS）", tier:"軽量",        pin:0.09, pout:0.28,  c:C.safe },
};
const AI_TASKS = [
  { id:"plan", name:"雑踏警備計画書の文章化", desc:"予測値 → 警察届出フォーマットの文章へ", diff:0.86, tin:2400, tout:1600, calls:()=>12,               unit:"版/イベント" },
  { id:"chat", name:"来場者「こまりごと」チャット", desc:"救護・迷子・アクセス等の自由入力応答", diff:0.45, tin:600, tout:250, calls:s=>Math.round(s.tickets*0.06*2.5), unit:"往復/イベント" },
  { id:"push", name:"通知・アナウンス文の多言語生成", desc:"12言語 × 時間帯セグメント（配信は一斉）", diff:0.18, tin:180, tout:120, calls:()=>264, unit:"生成/イベント" },
  { id:"sum",  name:"時間帯予報のひとこと要約", desc:"予報ストリップ用の自然文", diff:0.12, tin:300, tout:60, calls:()=>22, unit:"生成/イベント" },
];
const AI_ROUTE = {
  quality:  { plan:"frontier", chat:"frontier", push:"mid",   sum:"mid"   },
  balanced: { plan:"frontier", chat:"mid",      push:"cheap", sum:"cheap" },
  cost:     { plan:"mid",      chat:"cheap",    push:"cheap", sum:"cheap" },
};
const taskCost = (task, mkey, s) => {
  const m = AI_MODELS[mkey], n = task.calls(s);
  return n * (task.tin * m.pin + task.tout * m.pout) / 1e6;
};
const usd = x => x >= 10 ? `$${x.toFixed(0)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`;

function AIView({ s, plan }) {
  const [strategy,setStrategy]=useState("balanced");
  const [phase,setPhase]=useState("idle"); // idle | grade | route | gen | done | error
  const [log,setLog]=useState([]);
  const [result,setResult]=useState("");

  const steps=useMemo(()=>computeDay(s.date,envOf(s)),[s]);
  const tp=useMemo(()=>tentPlan(steps),[steps]);

  const route = AI_ROUTE[strategy];
  const routed = AI_TASKS.reduce((sum,tk)=>sum+taskCost(tk,route[tk.id],s),0);
  const baseline = AI_TASKS.reduce((sum,tk)=>sum+taskCost(tk,"frontier",s),0);
  const saved = Math.round((1-routed/baseline)*100);

  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const generate = async () => {
    if(phase==="grade"||phase==="route"||phase==="gen") return;
    setResult(""); setLog([]);
    try{
      setPhase("grade");
      setLog(l=>[...l,`> POST /v1/chat/completions  model: orcarouter/auto (${strategy})`]);
      await sleep(450);
      setLog(l=>[...l,`  grade: difficulty 0.86 ── 届出文体・数値整合が必要な高難度タスク`]);
      setPhase("route");
      await sleep(450);
      const mkey = route.plan, m = AI_MODELS[mkey];
      setLog(l=>[...l,`  route: ${m.name}（${m.tier}レーン）／ fallback 4段構成`]);
      setPhase("gen");
      setLog(l=>[...l,`  generating...`]);

      const wLabel=s.weather==="sunny"?"晴れ":s.weather==="cloudy"?"曇り":"雨";
      const prompt=`あなたはイベント雑踏警備計画の専門家です。以下の予測データから、雑踏警備計画書の「総括」欄に記載する要約を、日本語の届出文体で250字程度、段落1つで書いてください。箇条書き・見出しは使わないでください。数値は本文に自然に織り込んでください。

予測データ:
- 開催日: ${s.date.label}、天候${wLabel}、最高気温${s.temp}℃、湿度${s.RH}%、風速${s.v}m/s
- 来場規模: ${s.tickets.toLocaleString()}人（チケット販売数ベース）
- 混雑ピーク: ${plan.peakDH}:00 ${plan.peakDZ.name} 混雑指数${plan.peakD}、最大待機列 約${plan.waitMin}分
- 暑熱ピーク: ${plan.peakWH}:00 前後 WBGT ${plan.peakW}（${heatStyle(plan.peakW).label}）
- 推奨増員: 給水+${plan.water}名、救護+${plan.aid}名、誘導+${plan.guide}名${plan.mist?"、ミスト稼働":""}${plan.oneway?"、南通路一方通行化":""}${plan.entryCtl?"、入退場制限準備":""}${plan.stationCoord?"、鉄道事業者・警察と退場連携":""}
- 暑熱対策: ${tp.total>0?`可搬タープ${tp.total}張（${tp.list.map(p=>p.zone.name).join("・")}）を事前配置`:"建物日陰で基準を満たすため追加日除け不要"}`;

      const res = await fetch("/api/generate",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({prompt, strategy})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "API request failed");
      const text = (data.text || "").trim();
      if(!text) throw new Error("empty response");
      setResult(text);
      setLog(l=>[...l,`  done. OrcaRouter → ${data.model || "orcarouter/auto"} ／ 入力≈${Math.round(prompt.length/2)}tok / 出力≈${Math.round(text.length/2)}tok ── glass-box`]);
      setPhase("done");
    }catch(err){
      setLog(l=>[...l,`  error: 生成に失敗（${err.message}）。再試行してください。`]);
      setPhase("error");
    }
  };

  const diffColor = d => d>=0.7?C.violet:d>=0.35?C.cool:C.safe;

  return (
    <div>
      {/* 位置づけ */}
      <div style={{background:C.panel,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",
        display:"flex",gap:12,alignItems:"flex-start",marginBottom:16}}>
        <Route size={20} color={C.cool} style={{flexShrink:0,marginTop:2}}/>
        <div>
          <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>すべてのLLM呼び出しは OrcaRouter を経由する。</div>
          <div style={{fontSize:12.5,color:C.muted,lineHeight:1.7}}>
            OpenAI互換の単一エンドポイント。リクエストごとに難易度をグレーディングし、高難度タスクだけをフロンティアモデルへ、定型タスクは軽量モデルへ振り分ける。トークンへの上乗せ課金なし・全リクエストのモデル選定ログ・プロバイダ障害時の自動フェイルオーバー。審査基準【6】LLMコストへの回答がこのタブ。
          </div>
        </div>
      </div>

      <div className="cw-grid" style={{display:"grid",gridTemplateColumns:"minmax(0,1.2fr) minmax(0,1fr)",gap:16}}>

        {/* ---------- 左：ルーティング表 ---------- */}
        <Panel style={{padding:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:12}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <Cpu size={15} color={C.cool}/><Eyebrow>Routing Table ── タスク別振り分け</Eyebrow></div>
              <div style={{fontWeight:600,fontSize:16}}>AIを「使い分ける」のもAI。</div>
            </div>
            <div style={{display:"flex",gap:4,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:10,padding:3}}>
              {[["cost","コスト優先"],["balanced","バランス"],["quality","品質優先"]].map(([k,l])=>(
                <button key={k} onClick={()=>setStrategy(k)}
                  style={{padding:"6px 11px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,
                    background:strategy===k?C.cool:"transparent",color:strategy===k?C.ink:C.muted,border:"none"}}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginBottom:12}}>
            orcarouter/auto の実ストラテジー（cost / balanced / quality）に対応。来場規模スライダーに連動。
          </div>

          {AI_TASKS.map(tk=>{
            const mkey=route[tk.id], m=AI_MODELS[mkey];
            const cost=taskCost(tk,mkey,s), base=taskCost(tk,"frontier",s);
            return (
              <div key={tk.id} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:"12px 14px",marginBottom:9}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:13}}>{tk.name}</div>
                    <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:2}}>{tk.desc} ／ {tk.calls(s).toLocaleString()} {tk.unit}</div>
                  </div>
                  <Chip c={m.c}>→ {m.name}</Chip>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginTop:9}}>
                  <span style={{fontFamily:mono,fontSize:10,color:C.faint,width:64,flexShrink:0}}>難易度 {tk.diff.toFixed(2)}</span>
                  <div style={{flex:1,height:5,background:C.deep,borderRadius:99,overflow:"hidden"}}>
                    <div style={{width:`${tk.diff*100}%`,height:"100%",background:diffColor(tk.diff),borderRadius:99,transition:"all .3s"}}/>
                  </div>
                  <span style={{fontFamily:mono,fontSize:11,flexShrink:0}}>
                    {mkey!=="frontier"&&<span style={{color:C.faint,textDecoration:"line-through",marginRight:6}}>{usd(base)}</span>}
                    <b style={{color:m.c}}>{usd(cost)}</b>
                  </span>
                </div>
              </div>
            );
          })}

          {/* 合計 */}
          <div style={{marginTop:12,background:C.deep,border:`1px solid ${C.safe}44`,borderRadius:12,padding:"13px 15px",
            display:"flex",alignItems:"center",gap:12}}>
            <TrendingDown size={20} color={C.safe}/>
            <div style={{flex:1}}>
              <div style={{fontSize:12,color:C.muted}}>LLMコスト／1イベント（単価は概算・トークン上乗せ$0）</div>
              <div style={{fontFamily:mono,fontSize:15,marginTop:2}}>
                <span style={{color:C.faint,textDecoration:"line-through"}}>{usd(baseline)}</span>
                <span style={{color:C.faint}}> 全件フロンティア → </span>
                <span style={{color:C.mist,fontWeight:700}}>{usd(routed)}</span>
                <span style={{color:C.safe,fontWeight:700}}>（-{saved}%）</span>
              </div>
              <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginTop:2}}>コストの主因は来場者チャット（{AI_TASKS[1].calls(s).toLocaleString()}往復）。ここを軽量レーンに逃がせるかが勝負。</div>
            </div>
          </div>
        </Panel>

        {/* ---------- 右：実生成デモ ---------- */}
        <Panel style={{padding:18,alignSelf:"start"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
            <Sparkles size={15} color={C.violet}/><Eyebrow>Live Demo ── 計画書の実LLM生成</Eyebrow></div>
          <div style={{fontWeight:600,fontSize:16,marginBottom:10}}>いまの予報シナリオが、そのまま文章になる。</div>

          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
            <Chip c={C.muted}>{s.date.label}・{s.weather==="sunny"?"晴":s.weather==="cloudy"?"曇":"雨"} {s.temp}℃</Chip>
            <Chip c={C.muted}>{s.tickets.toLocaleString()}人</Chip>
            <Chip c={densStyle(plan.peakD).c}>混雑 {plan.peakD}</Chip>
            <Chip c={heatStyle(plan.peakW).c}>WBGT {plan.peakW}</Chip>
            {tp.total>0&&<Chip c={C.violet}>タープ {tp.total}張</Chip>}
          </div>

          <button onClick={generate} disabled={phase==="grade"||phase==="route"||phase==="gen"}
            style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,
              padding:"12px 0",borderRadius:11,cursor:"pointer",fontWeight:700,fontSize:14,
              background:phase==="gen"||phase==="grade"||phase==="route"?C.panel2:C.violet,
              color:phase==="gen"||phase==="grade"||phase==="route"?C.muted:C.ink,border:"none"}}>
            <Sparkles size={16}/>{phase==="grade"?"難易度をグレーディング中…":phase==="route"?"モデルを選定中…":phase==="gen"?"生成中…":"計画書「総括」を生成する"}
          </button>

          {log.length>0&&(
            <div style={{marginTop:12,background:C.deep,border:`1px solid ${C.line}`,borderRadius:11,padding:"11px 13px",
              fontFamily:mono,fontSize:10.5,color:C.muted,lineHeight:1.8,whiteSpace:"pre-wrap"}}>
              {log.join("\n")}
            </div>
          )}
          {result&&(
            <div style={{marginTop:12,background:C.panel2,border:`1px solid ${C.violet}44`,borderRadius:11,padding:"13px 15px",
              fontSize:12.5,lineHeight:1.9,color:C.mist}}>
              <div style={{fontFamily:mono,fontSize:10,color:C.faint,marginBottom:7}}>雑踏警備計画書 ── 総括（AI生成ドラフト）</div>
              {result}
            </div>
          )}

          <div style={{marginTop:12,fontFamily:mono,fontSize:10,color:C.faint,lineHeight:1.7}}>
            ※ 本デモの生成はデモ環境の制約上 Anthropic API 直結。本番実装は下の1行差し替えのみ。
          </div>

          {/* 統合コード */}
          <div style={{marginTop:12,background:C.deep,border:`1px solid ${C.line}`,borderRadius:11,padding:"13px 15px",
            fontFamily:mono,fontSize:11,lineHeight:1.8,overflowX:"auto"}}>
            <div style={{color:C.faint}}>// 統合はこれだけ（OpenAI互換）</div>
            <div><span style={{color:C.cool}}>const</span> client = <span style={{color:C.cool}}>new</span> OpenAI({"{"}</div>
            <div>&nbsp;&nbsp;baseURL: <span style={{color:C.safe}}>"https://api.orcarouter.ai/v1"</span>, <span style={{color:C.caution}}>// ← ここを変えるだけ</span></div>
            <div>&nbsp;&nbsp;apiKey: process.env.ORCA_KEY, <span style={{color:C.faint}}>// sk-orca-...</span></div>
            <div>{"}"});</div>
            <div style={{marginTop:4}}><span style={{color:C.cool}}>await</span> client.chat.completions.create({"{"}</div>
            <div>&nbsp;&nbsp;model: <span style={{color:C.safe}}>"orcarouter/auto"</span>, <span style={{color:C.faint}}>// 難易度に応じ自動選定</span></div>
            <div>&nbsp;&nbsp;messages, {"}"});</div>
          </div>

          <div style={{marginTop:12,display:"grid",gap:8}}>
            {[
              {ic:<Zap size={14} color={C.caution}/>,t:"1ms未満のグレーディング",d:"応答前に難易度判定。体感遅延なし。"},
              {ic:<Shield size={14} color={C.safe}/>,t:"自動フェイルオーバー",d:"プロバイダ障害時は健全なモデルへ再送。イベント当日の可用性を担保。"},
              {ic:<Lock size={14} color={C.cool}/>,t:"glass-box ルーティング",d:"全リクエストの難易度・選定モデル・単価をログ。監査可能なAI運用。"},
            ].map((f,i)=>(
              <div key={i} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:11,padding:"10px 12px"}}>
                <div style={{display:"flex",alignItems:"center",gap:7,fontWeight:700,fontSize:12.5}}>{f.ic}{f.t}</div>
                <div style={{fontSize:11.5,color:C.muted,marginTop:3,lineHeight:1.6}}>{f.d}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
