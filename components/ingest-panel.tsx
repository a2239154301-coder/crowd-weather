"use client";

import { useEffect, useRef, useState } from "react";
import { INK } from "@/lib/forecast/scales";
import { VENUE_CANVAS, type IngestedVenue, type IngestIssue } from "@/lib/ai/ingest-schema";
import type { Point, ZoneKind } from "@/lib/forecast/types";
import { costYenForMeta, formatYen } from "@/lib/ai/pricing";

/**
 * 優先01「会場資料の読解」のアップロードUI。
 *
 * ここが審査項目④（AIである必然性）のデモの入口。
 * 写真を1枚投げると、ゾーンと構造物が乗った会場図が返ってくる。
 *
 * 設計判断:
 * - 画像は**クライアント側で長辺1024pxへ縮小してから送る**（RESIZE_LONG_EDGE参照）。
 *   処理時間の支配項は画像サイズではなくモデル側の生成だったが（2026-08-11実測）、
 *   縮小はトークン原価と転送量を確実に減らし、サーバーに sharp を足さずに済む。
 *   スマホ撮影の図面（4000px級・数MB）も8MB上限に引っかからず送れるようになる。
 * - 結果は probe-render.mjs と同じ流儀で、元画像の上にSVGで重ねて描く。
 *   数値だけでは正しさが分からない。絵で確認できることが「人が補正する」前提の第一歩。
 */

const KIND_COLOR: Record<ZoneKind, string> = {
  stage: "#E5254A",
  indoor: "#A78BFA",
  gate: "#FB7A1E",
  corridor: "#38BDF8",
  queue: "#FDE047",
  aid: "#22C55E",
  station: "#7DD3FC",
  alley: "#F472B6",
};

const KIND_LABEL: Record<ZoneKind, string> = {
  stage: "ステージ",
  indoor: "屋内",
  gate: "ゲート",
  corridor: "通路",
  queue: "待機列",
  aid: "救護・給水",
  station: "駅",
  alley: "路地",
};

/**
 * 長辺をこのpxまで縮小してから送る。
 * 実測(2026-08-11・gpt-4.1): 768px=ゾーン5〜6件、1024px=ゾーン8件で所要時間は同じ約8秒。
 * gpt-4.1 は画像サイズが処理時間をほぼ左右しないため、粒度が上がる1024を採る。
 */
const RESIZE_LONG_EDGE = 1024;

type IngestMeta = {
  servedModel: string;
  requestedModel: string;
  fallbackLevel: number;
  router: string | null;
  resolvedModel: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  latencyMs: number;
};

type IngestResult = {
  venue: IngestedVenue;
  issues: IngestIssue[];
  meta: IngestMeta;
};

type ResizeInfo = {
  fromW: number;
  fromH: number;
  fromKB: number;
  toW: number;
  toH: number;
  toKB: number;
};

const fmtKB = (kb: number) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${Math.round(kb)}KB`);

/**
 * 画像を canvas で長辺 RESIZE_LONG_EDGE px に縮小し、JPEGにして返す。
 * PNGの透過は JPEG 化で黒く潰れるため、先に白で塗ってから描く。
 * 元から小さい画像は拡大しない。
 */
async function shrinkImage(file: File): Promise<{ blob: Blob; info: ResizeInfo; previewUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const fromW = bitmap.width;
  const fromH = bitmap.height;
  const scale = Math.min(1, RESIZE_LONG_EDGE / Math.max(fromW, fromH));
  const toW = Math.round(fromW * scale);
  const toH = Math.round(fromH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = toW;
  canvas.height = toH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context を取得できませんでした");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, toW, toH);
  ctx.drawImage(bitmap, 0, 0, toW, toH);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG変換に失敗しました"))), "image/jpeg", 0.9)
  );

  return {
    blob,
    info: { fromW, fromH, fromKB: file.size / 1024, toW, toH, toKB: blob.size / 1024 },
    previewUrl: canvas.toDataURL("image/jpeg", 0.9),
  };
}

export default function IngestPanel() {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<IngestResult | null>(null);
  const [resize, setResize] = useState<ResizeInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function run(file: File) {
    setBusy(true);
    setError("");
    setResult(null);
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);

    try {
      const { blob, info, previewUrl: url } = await shrinkImage(file);
      setResize(info);
      setPreviewUrl(url);

      const form = new FormData();
      form.append("file", blob, "venue.jpg");
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `読解に失敗しました（${res.status}）`);
      setResult(data as IngestResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読解に失敗しました。もう一度お試しください");
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setBusy(false);
    }
  }

  async function runSample() {
    setError("");
    try {
      const res = await fetch("/samples/venue-sample-1024.png");
      if (!res.ok) throw new Error("サンプル画像を読み込めませんでした");
      const blob = await res.blob();
      await run(new File([blob], "venue-sample.png", { type: "image/png" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "サンプル画像を読み込めませんでした");
    }
  }

  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) {
      setError(`対応していない形式です（${f.type || "不明"}）。PNG / JPEG / WebP を使ってください`);
      return;
    }
    void run(f);
  };

  const zones = result?.venue.zones ?? [];
  const buildings = result?.venue.buildings ?? [];

  /** まだ何も読み込んでいない初期状態。この間だけ「サンプル会場で試す」を推奨導線にする */
  const initial = !result;

  /**
   * 入口ボタンの強弱（2026-08-13 追加）。
   * 初回訪問者は手元に会場図を持っていないので、初期状態ではサンプルを主役にする。
   * 一度結果が出た後は「自分の画像を投げる」が主役に戻る。
   * 機能・文言は変えず色の強弱だけ入れ替える。busy中の見え方（塗り→枠線）も主役側に付いて回る。
   */
  const entryBtn = (primary: boolean): React.CSSProperties => ({
    minHeight: 44,
    padding: "10px 18px",
    borderRadius: 999,
    border: `1px solid ${primary ? INK.accent : INK.line}`,
    background: primary && !busy ? INK.accent : "transparent",
    color: primary ? (busy ? INK.accent : INK.page) : INK.textDim,
    fontWeight: primary ? 700 : 600,
    fontSize: 13,
    cursor: busy ? "wait" : "pointer",
  });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ── 説明と入口 ─────────────────────────────── */}
      <div
        style={{
          background: INK.surface,
          border: `1px solid ${INK.line}`,
          borderRadius: 12,
          padding: 16,
        }}
      >
        <div style={{ fontSize: 13, letterSpacing: 1.5, color: INK.textFaint }}>
          VENUE INGEST — OrcaRouter Vision + Structured Outputs
        </div>
        <div style={{ fontWeight: 600, fontSize: 15, marginTop: 3 }}>
          会場資料を、予報が読める地図に変換する。
        </div>
        <div style={{ fontSize: 13, color: INK.textDim, marginTop: 5, lineHeight: 1.7 }}>
          航空写真・会場図面を投げると、ゾーン（人が滞留する場所）と構造物（影を落とすもの）を
          読み取って構造化する。会場ごとに<b>1回きり</b>の処理。様式がバラバラな会場資料を
          ルールベースで読むことはできない — ここがLLMでないと成立しない中核。
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onFile(e.dataTransfer.files?.[0]);
          }}
          style={{
            marginTop: 13,
            border: `2px dashed ${dragOver ? INK.accent : INK.line}`,
            background: dragOver ? `${INK.accent}11` : INK.raised,
            borderRadius: 12,
            padding: "26px 16px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, color: INK.textDim }}>
            ここに画像をドロップ（PNG / JPEG / WebP）
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={entryBtn(!initial)}>
              ファイルを選ぶ
            </button>
            <button onClick={runSample} disabled={busy} style={entryBtn(initial)}>
              サンプル会場で試す
            </button>
          </div>
          {initial && (
            <div style={{ marginTop: 10, fontSize: 13, color: INK.textDim, lineHeight: 1.7 }}>
              手元に会場図が無ければ、<b style={{ color: INK.text }}>サンプル会場で試す</b>で動きを確認できます。
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 13, color: INK.textFaint }}>
            ブラウザ内で長辺{RESIZE_LONG_EDGE}pxへ縮小した縮小版のみサーバーへ送信（元解像度の画像は送らない）
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        {busy && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              color: INK.textDim,
              fontSize: 13,
            }}
          >
            <span className="cw-mono" style={{ fontSize: 19, fontWeight: 700, color: INK.accent }}>
              {elapsed}秒
            </span>
            <span>読解中… 通常10秒前後。混雑時はフォールバックを含め最大50秒ほどかかります</span>
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: "11px 13px",
              borderRadius: 10,
              border: "1px solid #E5254A66",
              background: "#E5254A14",
              color: "#FCA5A5",
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* ── 結果 ─────────────────────────────────── */}
      {result && (
        <div className="cw-split" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 312px", gap: 14 }}>
          {/* 読み取り結果を写真に重ねる（本命の絵） */}
          <section
            style={{
              background: INK.surface,
              border: `1px solid ${INK.line}`,
              borderRadius: 12,
              padding: 12,
            }}
          >
            <div style={{ position: "relative", borderRadius: 8, overflow: "hidden" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="読み込んだ会場資料" style={{ width: "100%", display: "block" }} />
              <svg
                viewBox={`0 0 ${VENUE_CANVAS.width} ${VENUE_CANVAS.height}`}
                preserveAspectRatio="none"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
              >
                <rect width={VENUE_CANVAS.width} height={VENUE_CANVAS.height} fill="#0A0E17" opacity={0.3} />
                {buildings.map((b) => {
                  const c = centroid(b.shape);
                  return (
                    <g key={b.id}>
                      <path
                        d={toPath(b.shape)}
                        fill="#0D1420"
                        fillOpacity={0.5}
                        stroke="#93A3C0"
                        strokeWidth={1.5}
                        strokeDasharray="5 3"
                      />
                      <text x={c.x} y={c.y} textAnchor="middle" fontSize={12} fill="#C7D2E5">
                        {b.name} {b.height}m
                      </text>
                    </g>
                  );
                })}
                {zones.map((z) => {
                  const c = centroid(z.shape);
                  const col = KIND_COLOR[z.kind] ?? "#fff";
                  return (
                    <g key={z.id}>
                      <path d={toPath(z.shape)} fill={col} fillOpacity={0.28} stroke={col} strokeWidth={2} />
                      <text
                        x={c.x}
                        y={c.y - 4}
                        textAnchor="middle"
                        fontSize={15}
                        fontWeight={600}
                        fill="#fff"
                        stroke="#0A0E17"
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {z.name}
                      </text>
                      <text
                        x={c.x}
                        y={c.y + 14}
                        textAnchor="middle"
                        fontSize={11}
                        fill={col}
                        stroke="#0A0E17"
                        strokeWidth={2.5}
                        paintOrder="stroke"
                      >
                        {KIND_LABEL[z.kind] ?? z.kind}
                        {z.roofed ? "・屋根" : ""}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div style={{ marginTop: 8, fontSize: 13, color: INK.textFaint, lineHeight: 1.6 }}>
              読み取ったゾーン（色つき）と構造物（破線）を元画像に重ねて表示。
              位置は人が補正する前提の初期案。
            </div>
          </section>

          {/* 読み取りの中身とメタ */}
          <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <ResultCard title="読み取り結果" note={result.venue.name}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <Chip color="#7DD3FC">ゾーン {zones.length}件</Chip>
                <Chip color="#93A3C0">構造物 {buildings.length}件</Chip>
                <Chip
                  color={
                    result.venue.confidence === "high"
                      ? "#22C55E"
                      : result.venue.confidence === "medium"
                        ? "#FDE047"
                        : "#FB7A1E"
                  }
                >
                  確信度 {result.venue.confidence}
                </Chip>
              </div>
              {result.venue.notes && (
                <p style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.8, color: INK.textDim }}>
                  <b style={{ color: INK.text }}>AIからの申し送り:</b> {result.venue.notes}
                </p>
              )}
            </ResultCard>

            {result.issues.length > 0 && (
              <ResultCard title="検証で見つかった点" note="normalizeIngested()">
                <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 5 }}>
                  {result.issues.map((it, i) => (
                    <li
                      key={i}
                      style={{
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: it.level === "error" ? "#FCA5A5" : "#FDBA74",
                      }}
                    >
                      {it.message}
                    </li>
                  ))}
                </ul>
              </ResultCard>
            )}

            <ResultCard title="処理の内訳" note="審査項目⑥の実測値">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <Chip color="#C4B5FD">{result.meta.servedModel}</Chip>
                {result.meta.fallbackLevel > 0 && (
                  <Chip color="#FB7A1E">第一候補が失敗 → {result.meta.fallbackLevel}段目で応答</Chip>
                )}
                {result.meta.usage && (
                  <Chip color="#93A3C0">
                    in {result.meta.usage.prompt_tokens} / out {result.meta.usage.completion_tokens} tok
                  </Chip>
                )}
                <Chip color="#93A3C0">{(result.meta.latencyMs / 1000).toFixed(1)}秒</Chip>
                <Chip color="#86EFAC">{formatYen(costYenForMeta(result.meta))}</Chip>
              </div>
              {resize && (
                <div className="cw-mono" style={{ marginTop: 9, fontSize: 13, color: INK.textFaint, lineHeight: 1.7 }}>
                  送信前縮小: {Math.round(resize.fromW)}×{Math.round(resize.fromH)} {fmtKB(resize.fromKB)} →{" "}
                  {resize.toW}×{resize.toH} {fmtKB(resize.toKB)}
                </div>
              )}
            </ResultCard>
          </aside>
        </div>
      )}
    </div>
  );
}

// ── 描画の小道具（probe-render.mjs と同じ流儀） ──────────────────

function toPath(poly: Point[]): string {
  return poly.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + "Z";
}

function centroid(poly: Point[]): Point {
  return {
    x: poly.reduce((a, p) => a + p.x, 0) / poly.length,
    y: poly.reduce((a, p) => a + p.y, 0) / poly.length,
  };
}

function ResultCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: INK.surface, border: `1px solid ${INK.line}`, borderRadius: 12, padding: 15 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: 0.4 }}>{title}</h2>
        {note && <span style={{ fontSize: 13, color: INK.textFaint }}>{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        color,
        background: `${color}1A`,
        border: `1px solid ${color}55`,
        borderRadius: 999,
        padding: "4px 10px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
