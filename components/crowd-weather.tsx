// @ts-nocheck
/* 馬場氏のモックをそのまま移植したファイル。propsが未型付けのため、このファイルだけ
   型チェックを外している（@ts-nocheck はファイル先頭の最初のコメントでないと効かない）。
   tsconfig の strict は true のままで、新規コード（app/api/**・lib/**）は型を付けて書く。
   優先01のリファクタ時に段階的に解消する。 */
"use client";

import React, { useState, useMemo } from "react";
import {
  Sun, Cloud, CloudRain, Droplets, Users, Thermometer, Umbrella,
  AlertTriangle, MapPin, FileText, Navigation, Shield, Clock,
  Sliders, ChevronRight, Activity, Train, Database, Zap, Lock,
  Smartphone, Bell, LifeBuoy, TrendingDown, Layers, Sparkles,
} from "lucide-react";

/* ============================================================
   CROWD WEATHER v2 — 混雑と暑熱の「予報」プロトタイプ
   AI HACK 2026
   会場外予報 / 会場内予報 / 暑熱予報 ＋ 来場者アプリ ＋ データ設計
   ============================================================ */

// ---- design tokens ----
const C = {
  ink: "#0A0F1E", panel: "#121A30", panel2: "#0F1728", deep: "#0B1120",
  line: "#22304F", mist: "#EAF0FB", muted: "#8695B8", faint: "#5C6A8C",
  cool: "#38BDF8", safe: "#22C55E", caution: "#FBBF24",
  busy: "#FB923C", danger: "#F43F5E", heat: "#EF4444", violet: "#A78BFA",
};
const display = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif";
const mono = "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace";

// ---- event timeline ----
const OPEN = 11, CLOSE = 21;
const HOURS = Array.from({ length: CLOSE - OPEN + 1 }, (_, i) => OPEN + i);
const OCC   = { 11:0.20,12:0.42,13:0.60,14:0.75,15:0.88,16:0.95,17:0.90,18:0.82,19:0.80,20:0.72,21:0.55 };
const SOLAR = { 11:0.72,12:0.90,13:1.0,14:0.96,15:0.84,16:0.66,17:0.46,18:0.26,19:0.10,20:0.02,21:0.0 };

/* ---- zones ----
   cover: 'roof' 常時日陰 / 'east' 東側建物→午前日陰 / 'west' 西側建物→夕方日陰 / null 日向
   （3D都市モデルによる時間帯別日陰計算のデモ簡略版） */
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
function wbgt(z, h, s) {
  const sun = s.weather === "sunny" ? 1 : s.weather === "cloudy" ? 0.45 : 0.12;
  const v = 21 + (s.temp - 28) * 0.6 + SOLAR[h] * sun * (isShaded(z, h) ? 1.6 : 6.6)
    + (z.type === "queue" ? 1.1 : 0) + (z.type === "gate" ? 0.6 : 0);
  return Math.round(v * 10) / 10;
}
const gateWait = (z, h, s) => Math.round(5 + density(z, h, s) * 0.5);

function densStyle(d){ return d<25?{c:C.safe,label:"快適"}:d<50?{c:C.caution,label:"注意"}:d<75?{c:C.busy,label:"混雑"}:{c:C.danger,label:"危険"}; }
function heatStyle(w){ return w<25?{c:C.cool,label:"涼"}:w<28?{c:C.caution,label:"警戒"}:w<31?{c:C.busy,label:"厳重警戒"}:{c:C.heat,label:"危険"}; }

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
  return { peakD,peakDZ,peakDH,peakW,peakWH,water,aid,guide,mist,oneway,entryCtl,stationCoord,waitMin,corridorDanger,outDanger,baselinePH,optimizedPH,saved };
}

// ---- atoms ----
const WeatherIcon = ({ w, size=18, color }) =>
  w==="sunny"?<Sun size={size} color={color}/>:w==="rainy"?<CloudRain size={size} color={color}/>:<Cloud size={size} color={color}/>;
const Panel = ({children,style}) => <div style={{background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,...style}}>{children}</div>;
const Eyebrow = ({children}) => <div style={{fontFamily:mono,fontSize:13,letterSpacing:2,color:C.faint,textTransform:"uppercase"}}>{children}</div>;
const Chip = ({c,children}) => <span style={{fontFamily:mono,fontSize:13,fontWeight:600,color:c,background:c+"1A",border:`1px solid ${c}44`,borderRadius:99,padding:"5px 11px"}}>{children}</span>;

// 太陽位置インジケータ（3D都市モデル日陰計算のデモ簡略）
function SunArc({ hour, weather }) {
  const t=(hour-OPEN)/(CLOSE-OPEN), a=Math.PI*(1-t), r=26, cx=34, cy=32;
  const x=cx+r*Math.cos(a), y=cy-r*Math.sin(a)*0.9;
  const set = hour>=19;
  return (
    <svg width="68" height="38" style={{overflow:"visible"}}>
      <path d={`M ${cx-r} ${cy} A ${r} ${r*0.9} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={C.line} strokeWidth="1.5" strokeDasharray="3 3"/>
      <circle cx={x} cy={y} r="5" fill={set?C.faint:weather==="sunny"?C.caution:C.muted}/>
      <text x={cx} y={cy+6} textAnchor="middle" fontSize="8" fill={C.faint} fontFamily={mono}>{set?"日没":"太陽位置"}</text>
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
            display:"grid",placeItems:"center",fontSize:13,fontWeight:800,color:C.ink,fontFamily:mono}}>{p.t}</div>
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

// ============================================================
export default function CrowdWeather() {
  const [view,setView]=useState("ops"); // ops | app | data
  const [s,setS]=useState({weather:"sunny",temp:34,tickets:24000});
  const [hour,setHour]=useState(16);
  const [scope,setScope]=useState("in"); // in | out
  const [layer,setLayer]=useState("crowd");
  const [showPlan,setShowPlan]=useState(false);
  const [aiAdvice,setAiAdvice]=useState("");
  const [aiLoading,setAiLoading]=useState(false);
  const [aiMeta,setAiMeta]=useState(null);   // ルーティング結果と原価（審査項目⑥の実測）

  const plan=useMemo(()=>dayPlan(s),[s]);
  const zones = scope==="in"?IN_ZONES:OUT_ZONES;
  const now=useMemo(()=>hourStats(zones,hour,s),[zones,hour,s]);
  const dayAlert=densStyle(plan.peakD);
  const set=(k,v)=>setS(p=>({...p,[k]:v}));

  // 表示中スコープの日陰カバー率（%）。hourStats は返さないのでここで算出する
  const shadeRate=useMemo(
    ()=>Math.round(zones.filter(z=>isShaded(z,hour)).length/zones.length*100),
    [zones,hour]
  );

  const askOrca = async () => {
    setAiLoading(true);
    setAiAdvice("");
    setAiMeta(null);
    const t0 = Date.now();
    try {
      const payload = {
        hour,
        scope: scope==="in" ? "会場内" : "会場外",
        weather: s.weather,
        temp: s.temp,
        tickets: s.tickets,
        current: {
          maxCrowd: now.maxD,
          maxCrowdZone: now.maxDZ.name,
          maxWBGT: now.maxW,
          maxWBGTZone: now.maxWZ.name,
          shadeRate,
        },
        dayPlan: {
          peakCrowd: plan.peakD,
          peakCrowdHour: plan.peakDH,
          peakCrowdZone: plan.peakDZ.name,
          peakWBGT: plan.peakW,
          peakWBGTHour: plan.peakWH,
        },
      };

      const res = await fetch("/api/advice", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "AI request failed");
      setAiAdvice(data.text || "提案を取得できませんでした。");
      setAiMeta({...(data.meta||{}), latencyMs: Date.now()-t0});
    } catch (e) {
      setAiAdvice("AI提案の取得に失敗しました。ORCAROUTER_API_KEY を確認してください（ローカル= .env.local ／ 本番= Vercelの環境変数）。");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div style={{minHeight:"100vh",background:C.ink,color:C.mist,fontFamily:display}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        input[type=range]{-webkit-appearance:none;appearance:none;height:4px;border-radius:99px;background:${C.line};outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${C.cool};border:3px solid ${C.ink};cursor:pointer;box-shadow:0 0 0 1px ${C.line}}
        input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:${C.cool};border:3px solid ${C.ink};cursor:pointer}
        *{box-sizing:border-box}
        @media(max-width:840px){.cw-grid{grid-template-columns:1fr!important}}`}</style>

      <div style={{maxWidth:1160,margin:"0 auto",padding:"22px 18px 64px"}}>

        {/* ---------- header ---------- */}
        <header style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:14,justifyContent:"space-between",marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{position:"relative",width:40,height:40,display:"grid",placeItems:"center"}}>
              <Cloud size={34} color={C.cool}/><Users size={15} color={C.ink} style={{position:"absolute",bottom:6}}/>
            </div>
            <div>
              <div style={{fontWeight:700,fontSize:19,letterSpacing:1}}>CROWD&nbsp;WEATHER</div>
              <div style={{fontFamily:mono,fontSize:13,color:C.muted,letterSpacing:1}}>混雑は、予報できる。</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:4,background:C.panel,border:`1px solid ${C.line}`,borderRadius:12,padding:4}}>
              {[["ops","主催者コンソール",<Sliders key="a" size={13}/>],["data","データ設計",<Database key="c" size={13}/>]].map(([k,l,ic])=>(
                <button key={k} onClick={()=>setView(k)}
                  style={{display:"flex",alignItems:"center",gap:6,minHeight:44,padding:"8px 13px",borderRadius:9,cursor:"pointer",
                    fontWeight:600,fontSize:13,border:"none",
                    background:view===k?C.cool:"transparent",color:view===k?C.ink:C.muted}}>{ic}{l}</button>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,background:C.panel,border:`1px solid ${dayAlert.c}55`,borderRadius:99,padding:"8px 14px"}}>
              <AlertTriangle size={16} color={dayAlert.c}/>
              <div>
                <div style={{fontFamily:mono,fontSize:13,color:C.faint,letterSpacing:1}}>本日の最大警戒</div>
                <div style={{fontWeight:700,fontSize:13,color:dayAlert.c}}>{dayAlert.label}・混雑{plan.peakD} / 暑熱{heatStyle(plan.peakW).label}</div>
              </div>
            </div>
          </div>
        </header>

        <div style={{fontFamily:mono,fontSize:13,color:C.faint,marginBottom:14}}>
          夏フェス想定・屋外会場 ／ 開場 {OPEN}:00 → 終演 {CLOSE}:00 ／ シナリオはB2B・来場者・計画書のすべてに連動
        </div>

        {view==="ops"&&(<>
          {/* ---------- 予報ストリップ ---------- */}
          <Panel style={{padding:16,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div><Eyebrow>Hourly Forecast ── 時間帯別予報</Eyebrow>
                <div style={{fontWeight:600,fontSize:15,marginTop:3}}>「今を見る」から「先を読む」へ</div></div>
              <div style={{fontFamily:mono,fontSize:13,color:C.faint}}>タップでマップに反映 ↓</div>
            </div>
            <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:4}}>
              {HOURS.map(h=>{
                const st=hourStats(zones,h,s),ds=densStyle(st.maxD),hs=heatStyle(st.maxW),active=h===hour;
                return (
                  <button key={h} onClick={()=>setHour(h)}
                    style={{flex:"0 0 auto",width:78,minHeight:44,background:active?C.panel2:"transparent",
                      border:`1px solid ${active?C.cool:C.line}`,borderRadius:12,padding:"10px 6px",
                      cursor:"pointer",color:C.mist,textAlign:"center",transition:"all .15s"}}>
                    <div style={{fontFamily:mono,fontSize:13,color:active?C.cool:C.muted}}>{h}:00</div>
                    <div style={{margin:"6px 0"}}><WeatherIcon w={s.weather} color={C.muted} size={17}/></div>
                    <div style={{height:44,display:"flex",alignItems:"flex-end",justifyContent:"center",gap:5}}>
                      <div title="混雑指数" style={{width:12,height:`${Math.max(6,st.maxD*0.42)}px`,background:ds.c,borderRadius:3}}/>
                      <div title="暑熱指数" style={{width:12,height:`${Math.max(6,(st.maxW-20)*3.4)}px`,background:hs.c,borderRadius:3,opacity:0.85}}/>
                    </div>
                    <div style={{fontFamily:mono,fontSize:13,marginTop:5,color:ds.c}}>{st.maxD}</div>
                  </button>
                );
              })}
            </div>
            <div style={{display:"flex",gap:16,marginTop:8,fontFamily:mono,fontSize:13,color:C.faint}}>
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
              <div style={{fontWeight:600,fontSize:15,marginBottom:16}}>予報が、そのままシフトになる。</div>

              <div style={{marginBottom:14}}>
                <div style={{fontSize:13,color:C.muted,marginBottom:7}}>天候</div>
                <div style={{display:"flex",gap:8}}>
                  {[["sunny","晴"],["cloudy","曇"],["rainy","雨"]].map(([k,l])=>(
                    <button key={k} onClick={()=>set("weather",k)}
                      style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                        minHeight:44,padding:"9px 0",borderRadius:10,cursor:"pointer",fontWeight:600,fontSize:13,
                        background:s.weather===k?C.cool:C.panel2,color:s.weather===k?C.ink:C.muted,
                        border:`1px solid ${s.weather===k?C.cool:C.line}`}}>
                      <WeatherIcon w={k} color={s.weather===k?C.ink:C.muted} size={16}/>{l}</button>
                  ))}
                </div>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <span style={{fontSize:13,color:C.muted}}>予想最高気温</span>
                  <span style={{fontFamily:mono,fontWeight:600,color:s.temp>=33?C.heat:C.mist}}>{s.temp}℃</span></div>
                <input type="range" min={22} max={39} value={s.temp} onChange={e=>set("temp",+e.target.value)} style={{width:"100%"}}/>
              </div>
              <div style={{marginBottom:18}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <span style={{fontSize:13,color:C.muted}}>チケット販売数（来場規模の最重要変数）</span>
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
                    <div style={{display:"flex",alignItems:"center",gap:6,color:C.muted,fontSize:13}}>{m.ic}{m.k}</div>
                    <div style={{fontFamily:mono,fontWeight:700,fontSize:19,color:m.c,marginTop:3}}>{m.v}</div>
                    <div style={{fontFamily:mono,fontSize:13,color:C.faint}}>{m.sub}</div>
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
                  <div style={{fontSize:13,color:C.muted}}>「厚く置く」→「賢く置く」（人時試算）</div>
                  <div style={{fontFamily:mono,fontSize:13,marginTop:2}}>
                    <span style={{color:C.faint,textDecoration:"line-through"}}>{plan.baselinePH}人時</span>
                    <span style={{color:C.faint}}> → </span>
                    <span style={{color:C.mist,fontWeight:700}}>{plan.optimizedPH}人時</span>
                    <span style={{color:C.safe,fontWeight:700}}>（-{plan.saved}%）</span>
                  </div>
                  <div style={{fontFamily:mono,fontSize:13,color:C.faint,marginTop:2}}>一律増員をやめ、ピーク時間帯・危険エリアに集中配置した場合</div>
                </div>
              </div>

              <button onClick={()=>setShowPlan(v=>!v)}
                style={{marginTop:14,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                  minHeight:44,padding:"12px 0",borderRadius:11,cursor:"pointer",fontWeight:700,fontSize:15,
                  background:C.cool,color:C.ink,border:"none"}}>
                <FileText size={17}/>{showPlan?"計画書を閉じる":"雑踏警備計画書＋配置図をワンクリック出力"}
              </button>
              {showPlan&&<PlanDoc s={s} plan={plan}/>}
            </Panel>

            {/* --- AI advisor --- */}
            <Panel style={{padding:18,marginBottom:16,gridColumn:"1 / -1"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                    <Sparkles size={15} color={C.violet}/>
                    <Eyebrow>AI OPERATIONS ADVISOR ── OrcaRouter</Eyebrow>
                  </div>
                  <div style={{fontWeight:600,fontSize:15}}>現在の予報から、次の打ち手をAIに聞く。</div>
                  <div style={{fontSize:13,color:C.muted,marginTop:5}}>
                    混雑・WBGT・日陰率・来場規模・時間帯を渡し、運営判断を短く提案します。
                  </div>
                </div>
                <button onClick={askOrca} disabled={aiLoading}
                  style={{display:"flex",alignItems:"center",gap:7,minHeight:44,padding:"10px 14px",borderRadius:10,
                    cursor:aiLoading?"wait":"pointer",fontWeight:700,fontSize:13,border:"none",
                    background:C.violet,color:C.ink,opacity:aiLoading?0.65:1}}>
                  <Sparkles size={15}/>{aiLoading?"分析中…":"AIに運営判断を聞く"}
                </button>
              </div>

              {aiAdvice && (
                <div style={{marginTop:13,background:C.deep,border:`1px solid ${C.violet}55`,
                  borderRadius:11,padding:"12px 14px",fontSize:13,lineHeight:1.75,whiteSpace:"pre-wrap"}}>
                  {aiAdvice}
                </div>
              )}

              {/* ルーティングをブラックボックスにしない ── 審査項目⑥の実測値をそのまま出す */}
              {aiMeta && (
                <div style={{marginTop:9,display:"flex",flexWrap:"wrap",gap:7,alignItems:"center",
                  fontFamily:mono,fontSize:13,color:C.faint}}>
                  <span>この提案を処理したモデル:</span>
                  <Chip c={C.violet}>{aiMeta.resolvedModel || aiMeta.servedModel || "unknown"}</Chip>
                  {aiMeta.router && <Chip c={C.cool}>router: {aiMeta.router}</Chip>}
                  {aiMeta.fallbackLevel > 0 && (
                    <Chip c={C.caution}>第一候補({aiMeta.requestedModel})が失敗 → {aiMeta.fallbackLevel}段目で応答</Chip>
                  )}
                  {aiMeta.usage && (
                    <Chip c={C.muted}>
                      in {aiMeta.usage.prompt_tokens} / out {aiMeta.usage.completion_tokens} tok
                    </Chip>
                  )}
                  <Chip c={C.muted}>{aiMeta.latencyMs}ms</Chip>
                </div>
              )}
            </Panel>

            {/* --- map --- */}
            <Panel style={{padding:18}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:10}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                    <MapPin size={15} color={C.cool}/><Eyebrow>{scope==="in"?"会場内予報 × 暑熱予報":"会場外予報 ── 駅動線・路地"}</Eyebrow></div>
                  <div style={{fontWeight:600,fontSize:15}}>{hour}:00 の予測</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{display:"flex",gap:4,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:10,padding:3}}>
                    {[["in","会場内"],["out","会場外"]].map(([k,l])=>(
                      <button key={k} onClick={()=>setScope(k)}
                        style={{minHeight:44,padding:"6px 11px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,
                          background:scope===k?C.violet:"transparent",color:scope===k?C.ink:C.muted,border:"none"}}>{l}</button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:4,background:C.panel2,border:`1px solid ${C.line}`,borderRadius:10,padding:3}}>
                    {[["crowd","混雑"],["heat","暑熱/日陰"]].map(([k,l])=>(
                      <button key={k} onClick={()=>setLayer(k)}
                        style={{minHeight:44,padding:"6px 11px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,
                          background:layer===k?C.cool:"transparent",color:layer===k?C.ink:C.muted,border:"none"}}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>

              <ZoneMap zones={zones} hour={hour} s={s} layer={layer}/>

              <div style={{display:"flex",alignItems:"center",gap:14,marginTop:12}}>
                <SunArc hour={hour} weather={s.weather}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontFamily:mono,fontSize:13,color:C.faint,marginBottom:6}}>
                    <span>開場 {OPEN}:00</span><span>時間スクラバー</span><span>終演 {CLOSE}:00</span></div>
                  <input type="range" min={OPEN} max={CLOSE} value={hour} onChange={e=>setHour(+e.target.value)} style={{width:"100%"}}/>
                </div>
              </div>
              <div style={{fontFamily:mono,fontSize:13,color:C.faint,marginTop:6}}>
                ☂ = その時間帯に日陰（3D都市モデルによる時間帯別日陰計算・デモ簡略版）。時間を動かすと日陰が東→西へ移る。
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:12}}>
                <div style={{background:C.panel2,border:`1px solid ${densStyle(now.maxD).c}44`,borderRadius:11,padding:"10px 12px"}}>
                  <div style={{fontSize:13,color:C.muted,display:"flex",gap:6,alignItems:"center"}}><Users size={13} color={densStyle(now.maxD).c}/>最混雑</div>
                  <div style={{fontWeight:700,fontSize:15,marginTop:3,color:densStyle(now.maxD).c}}>{now.maxDZ.name}・{densStyle(now.maxD).label}</div>
                </div>
                <div style={{background:C.panel2,border:`1px solid ${heatStyle(now.maxW).c}44`,borderRadius:11,padding:"10px 12px"}}>
                  <div style={{fontSize:13,color:C.muted,display:"flex",gap:6,alignItems:"center"}}><Thermometer size={13} color={heatStyle(now.maxW).c}/>最暑熱</div>
                  <div style={{fontWeight:700,fontSize:15,marginTop:3,color:heatStyle(now.maxW).c}}>{now.maxWZ.name}・{heatStyle(now.maxW).label}</div>
                </div>
              </div>
              {scope==="out"&&(
                <div style={{marginTop:10,fontFamily:mono,fontSize:13,color:C.muted,lineHeight:1.7,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:10,padding:"10px 12px"}}>
                  会場外予報：開場前（{OPEN}:00）は駅→ゲートの流入、終演後（{CLOSE-1}:00〜）は路地・ホームへの逆流が詰まりの主因。
                  {plan.outDanger?" 本シナリオでは商店街の路地が危険密度に達するため、鉄道事業者・警察との退場連携を推奨。":" 本シナリオでは許容範囲。"}
                </div>
              )}
            </Panel>
          </div>
        </>)}

        {view==="data"&&<DataView/>}

        <div style={{marginTop:22,display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",justifyContent:"space-between",fontFamily:mono,fontSize:13,color:C.faint}}>
          <span style={{display:"flex",alignItems:"center",gap:6}}><Shield size={13} color={C.faint}/>事故ゼロと、最高の体験は、両立できる。</span>
          <span>CROWD WEATHER ｜ AI HACK 2026 ｜ powered by OrcaRouter</span>
        </div>
      </div>
    </div>
  );
}

// ---- 計画書＋配置図 ----
function PlanDoc({ s, plan }) {
  const wLabel=s.weather==="sunny"?"晴":s.weather==="cloudy"?"曇":"雨";
  const ops=[`給水スタッフ +${plan.water}`,`救護スタッフ +${plan.aid}`,`誘導スタッフ +${plan.guide}`,
    plan.mist?"ミスト稼働":null,plan.oneway?"南通路 一方通行化":null,
    plan.entryCtl?"入退場制限の準備":null,plan.stationCoord?"鉄道事業者・警察と退場時連携":null].filter(Boolean);
  const dots=staffDots(s,plan);
  return (
    <div style={{marginTop:14,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:12,padding:16,fontFamily:mono}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:13,fontWeight:700,color:C.mist}}>雑踏警備計画書（自動生成・抜粋）</div>
        <div style={{fontSize:13,color:C.faint}}>DRAFT ／ 警察届出・社内稟議フォーマット準拠</div>
      </div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
        <tbody style={{color:C.muted}}>
          {[
            ["予報シナリオ",`${wLabel}・${s.temp}℃ ／ 来場規模 ${s.tickets.toLocaleString()}`],
            ["最大混雑",`混雑指数 ${plan.peakD}（${plan.peakDH}:00 ${plan.peakDZ.name}）／ 待機列 約${plan.waitMin}分`],
            ["暑熱リスク",`WBGT ${plan.peakW}（${heatStyle(plan.peakW).label}）／ ${plan.peakWH}:00 前後がピーク`],
            ["推奨配置",ops.join(" ／ ")],
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
        <div style={{fontSize:13,color:C.faint,marginBottom:6}}>配置図（ピーク {plan.peakDH}:00 時点・自動生成）</div>
        <ZoneMap zones={IN_ZONES} hour={plan.peakDH} s={s} layer="crowd" height={170} mini staff={dots}/>
        <div style={{display:"flex",gap:12,marginTop:7,fontSize:13,color:C.faint}}>
          <span><i style={{display:"inline-block",width:9,height:9,borderRadius:99,background:C.cool,marginRight:4}}/>給水</span>
          <span><i style={{display:"inline-block",width:9,height:9,borderRadius:99,background:C.caution,marginRight:4}}/>誘導</span>
          <span><i style={{display:"inline-block",width:9,height:9,borderRadius:99,background:C.safe,marginRight:4}}/>救護</span>
        </div>
      </div>
      <div style={{marginTop:10,fontSize:13,color:C.faint,display:"flex",alignItems:"center",gap:6}}>
        <ChevronRight size={12} color={C.faint}/>時間帯別シフト表・PDF出力に対応（本デモは抜粋）。実データ学習で会場ごとに最適化。
      </div>
    </div>
  );
}

// ---- データ設計 ----
export function DataView() {
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
  const Feed=({f})=><span style={{fontFamily:mono,fontSize:13,color:f==="混雑"?C.busy:C.heat,background:(f==="混雑"?C.busy:C.heat)+"1A",border:`1px solid ${(f==="混雑"?C.busy:C.heat)}44`,borderRadius:99,padding:"2px 8px"}}>→{f}予測</span>;
  const Card=({d})=>(
    <div style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:12,padding:"12px 14px"}}>
      <div style={{fontWeight:700,fontSize:13}}>{d.n}</div>
      <div style={{fontFamily:mono,fontSize:13,color:C.faint,margin:"3px 0 7px"}}>{d.src}{d.note?` ── ${d.note}`:""}</div>
      <div style={{display:"flex",gap:6}}>{d.feeds.map(f=><Feed key={f} f={f}/>)}</div>
    </div>
  );
  return (
    <div className="cw-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <Panel style={{padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Database size={15} color={C.cool}/><Eyebrow>東京都オープンデータ 等</Eyebrow></div>
        <div style={{fontWeight:600,fontSize:15,marginBottom:14}}>誰でも使える「土台」</div>
        <div style={{display:"grid",gap:10}}>{open.map((d,i)=><Card key={i} d={d}/>)}</div>
        <div style={{marginTop:12,fontFamily:mono,fontSize:13,color:C.faint,lineHeight:1.7}}>
          ※ 3D都市モデルの活用は、2024年度都知事杯受賞作「高解像度熱中症リスクマップ」の系譜。本デモの日陰計算はその簡略版。
        </div>
      </Panel>
      <Panel style={{padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Zap size={15} color={C.caution}/><Eyebrow>民間 × 自社データ</Eyebrow></div>
        <div style={{fontWeight:600,fontSize:15,marginBottom:14}}>私たちしか持ち込めない「差」</div>
        <div style={{display:"grid",gap:10}}>{priv.map((d,i)=><Card key={i} d={d}/>)}</div>
        <div style={{marginTop:12,background:C.deep,border:`1px dashed ${C.line}`,borderRadius:11,padding:"11px 13px",display:"flex",gap:9}}>
          <Lock size={14} color={C.caution} style={{flexShrink:0,marginTop:2}}/>
          <div style={{fontSize:13,color:C.muted,lineHeight:1.7}}>
            民間イベントデータは、主催者との信頼関係がなければ集まらない。イベント制作の当事者である私たち自身が「データの持ち込み手」——ここが最大の参入障壁になる。
          </div>
        </div>
      </Panel>
    </div>
  );
}
