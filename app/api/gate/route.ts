import { NextResponse } from "next/server";
import { GATE_COOKIE } from "@/lib/demo-gate";

/** タイミング攻撃を避けるための定数時間比較 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  const required = process.env.DEMO_ACCESS_KEY;
  if (!required) {
    return NextResponse.json({ error: "ゲートは無効です" }, { status: 400 });
  }

  const { passphrase } = (await req.json().catch(() => ({}))) as { passphrase?: string };
  if (typeof passphrase !== "string" || !timingSafeEqual(passphrase, required)) {
    return NextResponse.json({ error: "合言葉が違います" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(GATE_COOKIE, required, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 14, // ハッカソン期間の2週間で十分
  });
  return res;
}
