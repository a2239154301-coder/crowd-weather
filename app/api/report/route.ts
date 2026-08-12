import { NextResponse } from "next/server";
import { callOrca, OrcaError } from "@/lib/ai/orca";
import { addReport, listReports, type ReportKind } from "@/lib/ops/store";
import { isValidZoneId, zoneById } from "@/lib/ops/staffing";
import { zonesFor } from "@/lib/forecast/venue";

/**
 * スタッフ報告の受け付け。
 *
 * 2形式:
 *  - ボタン報告: {name, zoneId, kind: crowd|heat|trouble, level: 1-5} — LLM不使用でそのまま保存
 *  - 自由文報告: {name, zoneId?, text} — **LLMは構造化（翻訳）だけ**を行い、
 *    {zoneId, kind, level, summary} に変換して保存（What-if・route-intent と同じ翻訳専用型。
 *    判断はしない。改訂CLAUDE.mdのLLM役割③「観測の構造化」）
 */

const KINDS: ReportKind[] = ["crowd", "heat", "trouble"];

const IN_ZONES = zonesFor("in");
const ZONE_IDS = IN_ZONES.map((z) => z.id);
const ZONE_GUIDE = IN_ZONES.map((z) => `${z.id}=${z.name}`).join(" / ");

// ⚠ union型はGemini互換層が400になるため使わない（whatifと同じ制約）
const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    zoneId: {
      type: "string",
      enum: ZONE_IDS,
      description: "報告が指す場所。言及がなければ報告者の現在ゾーンをそのまま返す",
    },
    kind: {
      type: "string",
      enum: ["crowd", "heat", "trouble"],
      description: "報告の種類。混雑・列・人が多い→crowd、暑さ・体調・熱中症→heat、事故・喧嘩・落とし物・その他→trouble",
    },
    level: {
      type: "number",
      description: "深刻度1-5。5=いますぐ対応が要る。判断に迷えば高い方に倒す（安全側）",
    },
    summary: {
      type: "string",
      description: "指示者が3秒で読める要約（日本語・30字以内）",
    },
    understood: { type: "boolean", description: "現場報告として解釈できたか" },
  },
  required: ["zoneId", "kind", "level", "summary", "understood"],
} as const;

const REPORT_SYSTEM = `あなたはイベント警備の現場報告の入力インタフェースです。
スタッフの自由な言い方を、構造化された報告データに変換してください。

会場内のゾーン（id=名前）: ${ZONE_GUIDE}

- 変換だけを行う。対応の提案・状況の評価はしない（それは指示者と計算エンジンの仕事）
- 深刻度に迷ったら高い方に倒す（安全側）
- 場所の言及がなければ、渡された報告者の現在ゾーンを使う
- 現場報告として解釈できない入力は understood:false`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? 0) || undefined;
  return NextResponse.json({ reports: await listReports(since) });
}

export async function POST(req: Request) {
  let body: { name?: unknown; zoneId?: unknown; kind?: unknown; level?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 30) : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const homeZone = typeof body.zoneId === "string" && isValidZoneId(body.zoneId) ? body.zoneId : "main";

  // ── ボタン報告（LLM不使用） ──
  if (typeof body.text !== "string" || !body.text.trim()) {
    const kind = KINDS.includes(body.kind as ReportKind) ? (body.kind as ReportKind) : null;
    const level = typeof body.level === "number" ? Math.max(1, Math.min(5, Math.round(body.level))) : null;
    if (!kind || level === null) {
      return NextResponse.json({ error: "kind and level (1-5) are required for button reports" }, { status: 400 });
    }
    const zoneName = zoneById(homeZone)?.name ?? homeZone;
    const kindLabel = kind === "crowd" ? "混雑" : kind === "heat" ? "暑さ" : "トラブル";
    const report = await addReport({
      name,
      zoneId: homeZone,
      kind,
      level,
      text: "",
      summary: `${zoneName}の${kindLabel} レベル${level}`,
      source: "staff-button",
    });
    return NextResponse.json({ report });
  }

  // ── 自由文報告（LLMで構造化） ──
  try {
    const { text, meta } = await callOrca({
      task: "whatif", // 翻訳専用レーン
      system: REPORT_SYSTEM,
      user: `報告者の現在ゾーン: ${homeZone}\n\n報告: ${body.text.slice(0, 300)}`,
      extras: { jsonSchema: { name: "staff_report", schema: REPORT_SCHEMA } },
    });
    let parsed: { zoneId?: string; kind?: string; level?: number; summary?: string; understood?: boolean };
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "報告を解釈できませんでした" }, { status: 502 });
    }
    if (parsed.understood === false) {
      return NextResponse.json({
        report: null,
        interpretation: parsed.summary ?? "現場報告として解釈できませんでした",
        meta,
      });
    }
    const zoneId = parsed.zoneId && isValidZoneId(parsed.zoneId) ? parsed.zoneId : homeZone;
    const kind = KINDS.includes(parsed.kind as ReportKind) ? (parsed.kind as ReportKind) : "trouble";
    const level = Math.max(1, Math.min(5, Math.round(parsed.level ?? 3)));
    const report = await addReport({
      name,
      zoneId,
      kind,
      level,
      text: body.text.slice(0, 300),
      summary: (parsed.summary ?? body.text).slice(0, 60),
      source: "staff-text",
    });
    return NextResponse.json({ report, meta });
  } catch (error) {
    if (error instanceof OrcaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
