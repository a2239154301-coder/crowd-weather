import { NextResponse } from "next/server";
import { USD_JPY } from "@/lib/ai/pricing";

/**
 * OrcaRouter 課金APIのプロキシ — ハッカソン期間の**累計実費**を画面に出す。
 *
 * docs: /operations/billing-and-usage
 *   GET /v1/dashboard/billing/usage        … 累計使用額（OpenAI形状・total_usage はセント）
 *   GET /v1/dashboard/billing/subscription … 残高・期限
 *
 * サーバー側でプロキシする理由は orca.ts と同じ（キーをブラウザに出さない）。
 * 取得できないときは 200 + {available:false} を返し、UI側は非表示にする
 * （審査デモ中に課金APIの一時障害で画面が壊れるのを避ける）。
 *
 * ⚠ ここで返す数字だけが「実測原価の累計」。トークン×公表単価の換算値
 * （lib/ai/pricing.ts）は「概算」と表記を分けること。
 */

const ORCA_BASE = "https://api.orcarouter.ai/v1";

export const dynamic = "force-dynamic";

export async function GET() {
  const apiKey = process.env.ORCAROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ available: false });
  }

  try {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const [usageRes, subRes] = await Promise.all([
      fetch(`${ORCA_BASE}/dashboard/billing/usage`, { headers, cache: "no-store" }),
      fetch(`${ORCA_BASE}/dashboard/billing/subscription`, { headers, cache: "no-store" }),
    ]);
    if (!usageRes.ok) {
      return NextResponse.json({ available: false });
    }

    // OpenAI形状: { total_usage: <cents> }
    const usage = (await usageRes.json()) as { total_usage?: number };
    const sub = subRes.ok
      ? ((await subRes.json()) as { hard_limit_usd?: number })
      : {};

    const totalUsd = (usage.total_usage ?? 0) / 100;
    return NextResponse.json({
      available: true,
      totalUsd,
      totalYen: totalUsd * USD_JPY,
      limitUsd: sub.hard_limit_usd ?? null,
      usdJpy: USD_JPY,
    });
  } catch {
    return NextResponse.json({ available: false });
  }
}
