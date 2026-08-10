import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE } from "@/lib/demo-gate";

/**
 * デモ期間だけの簡易アクセス制御。
 *
 * `/api/advice` はOrcaRouterのクレジット（3,000円/人）を直接消費する。
 * publicなVercel URLに認証なしで置くと、誰でも叩いて枯らせてしまう。
 *
 * ヘッダに合言葉を埋める方式は、クライアント側JSに書いた時点で
 * view-sourceで誰でも取り出せるため意味がない。ここでは
 * HttpOnly Cookie による簡易ゲートにしている（/gate で合言葉を入力 → Cookie発行）。
 * Cookieはブラウザからのみ送られサーバー側でしか読めない。
 *
 * DEMO_ACCESS_KEY が未設定ならゲートは無効（ローカル開発を邪魔しない）。
 * 本格的な認証（OrcaRouter Guardrails・Agent Firewall等）は優先04で扱う。
 */

const PUBLIC_PATHS = ["/gate", "/api/gate", "/favicon.ico"];

export function middleware(req: NextRequest) {
  const required = process.env.DEMO_ACCESS_KEY;
  if (!required) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || pathname.startsWith("/_next")) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(GATE_COOKIE)?.value;
  if (cookie === required) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "このデモは合言葉が必要です（/gate から入力）" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
