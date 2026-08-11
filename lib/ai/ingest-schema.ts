import type { Venue, Zone, Building, Point, ZoneKind } from "@/lib/forecast/types";

/**
 * 会場資料の読解（優先01）で AI に返させる JSON の形。
 *
 * Venue 型そのものではなく、**AIが写真から読み取れる部分だけ**を schema にしている。
 * width/height/open/close はアプリ側が決めるのでAIには出させない。
 * northDeg / confidence / notes は「読み取れなかったもの」を人に伝えるための欄。
 *
 * 2026-08-10 の検証（scripts/probe-ingest.mjs）で、この schema が
 * google/gemini-2.5-pro・openai/gpt-4o の両方で strict:true のまま通ることを確認済み。
 */

export const VENUE_CANVAS = { width: 1000, height: 700 } as const;

/** 写真から読み取れないもの。人が補正する前提で持つ */
export type IngestUncertainty = {
  /** 画像上で北がどちらか（0=上, 90=右, 180=下, 270=左）。判断できなければ0 */
  northDeg: number;
  confidence: "high" | "medium" | "low";
  /** 読み取れなかったもの・人が補正すべき点 */
  notes: string;
};

export type IngestedVenue = IngestUncertainty & {
  name: string;
  zones: Zone[];
  buildings: Building[];
};

const pointSchema = {
  type: "object",
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
} as const;

const ZONE_KINDS: ZoneKind[] = [
  "stage",
  "indoor",
  "gate",
  "corridor",
  "queue",
  "aid",
  "station",
  "alley",
];

export const INGEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      description: "会場の名称。資料から読み取れなければ「特設会場」等の一般名",
    },
    northDeg: {
      type: "number",
      description:
        "画像上で北がどちらを向くか（0=画像上方向、90=右、180=下、270=左）。判断できなければ0",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: {
      type: "string",
      description: "読み取れなかったもの・人が補正すべき点を日本語で簡潔に",
    },
    zones: {
      type: "array",
      description: "来場者が滞留・移動する領域",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "英小文字の短いID" },
          name: { type: "string", description: "日本語の名称" },
          kind: { type: "string", enum: ZONE_KINDS },
          base: { type: "number", description: "混みやすさ係数 0.3〜1.0" },
          roofed: { type: "boolean", description: "屋根の下にあるか" },
          shape: {
            type: "array",
            description: `多角形の頂点。3〜8個。左上原点で x:0-${VENUE_CANVAS.width}, y:0-${VENUE_CANVAS.height}`,
            items: pointSchema,
          },
        },
        required: ["id", "name", "kind", "base", "roofed", "shape"],
      },
    },
    buildings: {
      type: "array",
      description: "影を落とす構造物。建物・ステージの屋根・テント・タワーなど",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          height: { type: "number", description: "推定の高さ(m)。用途から推定してよい" },
          shape: { type: "array", items: pointSchema },
        },
        required: ["id", "name", "height", "shape"],
      },
    },
  },
  required: ["name", "northDeg", "confidence", "notes", "zones", "buildings"],
} as const;

export const INGEST_SYSTEM = `あなたはイベント会場の資料（航空写真・会場図面・平面図）を読み取り、
雑踏警備の計画に使える構造化データに変換する専門家です。

読み取りの原則:
- 座標は必ず左上を原点とし、x は 0〜${VENUE_CANVAS.width}、y は 0〜${VENUE_CANVAS.height} の範囲に正規化すること。
  画像の縦横比に関わらず、画像全体がこの矩形に収まるものとして換算する。
- zones は「人が滞留する場所・並ぶ場所・通る場所」を取る。観客エリア、待機列、
  飲食エリア、トイレ列、救護・給水、ゲート、通路など。
  領域どうしが重ならないようにすること。
- buildings は「影を落とす構造物」を取る。ステージの屋根、テント、タワー、
  周辺の建物など。高さは用途から推定してよい（仮設テント3m、ステージ屋根12m、
  PAタワー8m、中層ビル30m など）。
- 多角形は実際の形に沿わせる。長方形で済むものは4点でよいが、
  斜めの領域は斜めのまま取ること。
- 写真から読み取れないもの（実寸・縮尺・正確な方位・建物の正確な高さ）は
  推測でよいが、notes に「人が補正すべき」と明記すること。
- 確信が持てない領域を無理に作らない。確実なものだけを返す。
- **zones は最大8件、buildings は最大8件まで。警備上の重要度が高いものから順に返すこと。**
  （実測で出力7,155トークンを要し、Vercelの実行時間上限60秒を超えていた。
  件数を絞るのが最も効く。json_schema の maxItems は OpenAI の strict モードが
  受け付けずフォールバック経路を壊すため、指示側で絞っている）`;

export const INGEST_USER =
  "この会場資料から、雑踏警備の予報に使うゾーンと構造物を読み取ってJSONにしてください。";

// ── 検証と正規化 ──────────────────────────────────────────────

export type IngestIssue = { level: "error" | "warn"; message: string };

function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(a / 2);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * AIの出力をそのまま信用せず、地図として成立する形に正規化する。
 *
 * 検証で分かったこと: 座標の範囲は守られるが、**領域どうしが重なることがある**。
 * ここでは落とさず警告に留め、人が補正できるようにする（警備計画は人が判を押す文書）。
 */
export function normalizeIngested(raw: IngestedVenue): {
  venue: IngestedVenue;
  issues: IngestIssue[];
} {
  const issues: IngestIssue[] = [];
  const { width: W, height: H } = VENUE_CANVAS;

  const fixShape = (shape: Point[], label: string): Point[] | null => {
    if (!Array.isArray(shape) || shape.length < 3) {
      issues.push({ level: "error", message: `${label}: 頂点が${shape?.length ?? 0}個しかないため除外しました` });
      return null;
    }
    const fixed = shape.map((p) => ({ x: clamp(Number(p.x) || 0, 0, W), y: clamp(Number(p.y) || 0, 0, H) }));
    if (polygonArea(fixed) < 150) {
      issues.push({ level: "warn", message: `${label}: 面積が極端に小さいため確認してください` });
    }
    return fixed;
  };

  const zones: Zone[] = [];
  for (const z of raw.zones ?? []) {
    const shape = fixShape(z.shape, `ゾーン「${z.name}」`);
    if (!shape) continue;
    zones.push({
      id: z.id || `z${zones.length}`,
      name: z.name || "無名エリア",
      kind: z.kind,
      base: clamp(Number(z.base) || 0.6, 0.1, 1.2),
      roofed: Boolean(z.roofed),
      shape,
    });
  }

  const buildings: Building[] = [];
  for (const b of raw.buildings ?? []) {
    const shape = fixShape(b.shape, `構造物「${b.name}」`);
    if (!shape) continue;
    const height = Number(b.height);
    if (!(height > 0)) {
      issues.push({ level: "warn", message: `構造物「${b.name}」: 高さが不明なため12mを仮置きしました` });
    }
    buildings.push({
      id: b.id || `b${buildings.length}`,
      name: b.name || "構造物",
      height: height > 0 ? clamp(height, 1, 300) : 12,
      shape,
    });
  }

  if (zones.length === 0) {
    issues.push({ level: "error", message: "ゾーンを1つも読み取れませんでした。別の資料を試してください" });
  }
  if (buildings.length === 0) {
    issues.push({ level: "warn", message: "影を落とす構造物が見つかりません。日陰の計算ができません" });
  }

  return {
    venue: {
      name: raw.name || "特設会場",
      northDeg: clamp(Number(raw.northDeg) || 0, 0, 359),
      confidence: raw.confidence ?? "low",
      notes: raw.notes ?? "",
      zones,
      buildings,
    },
    issues,
  };
}

/** 読み取り結果を、予報計算がそのまま使える Venue 型に組み立てる */
export function toVenue(ingested: IngestedVenue, opts?: { open?: number; close?: number }): Venue {
  return {
    id: "ingested",
    name: ingested.name,
    width: VENUE_CANVAS.width,
    height: VENUE_CANVAS.height,
    open: opts?.open ?? 11,
    close: opts?.close ?? 21,
    zones: ingested.zones,
    buildings: ingested.buildings,
    // 地面の下地は写真から判定しない。全面を舗装として扱う
    ground: [
      {
        id: "g-base",
        kind: "paved",
        shape: [
          { x: 0, y: 0 },
          { x: VENUE_CANVAS.width, y: 0 },
          { x: VENUE_CANVAS.width, y: VENUE_CANVAS.height },
          { x: 0, y: VENUE_CANVAS.height },
        ],
      },
    ],
  };
}
