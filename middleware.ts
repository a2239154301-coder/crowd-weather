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
 *
 * ルート「/」は 2026-08-14、馬場氏制作のスタンドアロンHTML
 * （public/CROWD_WEATHER_v5.html）へ内部リライトする（提出物の正本をここに一本化）。
 * URLは "/" のまま変わらない。旧Next.js UI（AppShell）は /internal で引き続き参照できる。
 * ゲート判定は元のpathname（"/"）に対して行うため保護範囲は変わらない。
 */

const PUBLIC_PATHS = ["/gate", "/api/gate", "/favicon.ico"];

function rootAware(req: NextRequest, res: NextResponse): NextResponse {
  if (req.nextUrl.pathname === "/" && req.method === "GET") {
    const url = req.nextUrl.clone();
    url.pathname = "/CROWD_WEATHER_v5.html";
    return NextResponse.rewrite(url);
  }
  return res;
}

export function middleware(req: NextRequest) {
  const required = process.env.DEMO_ACCESS_KEY;
  if (!required) return rootAware(req, NextResponse.next());

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || pathname.startsWith("/_next")) {
    return rootAware(req, NextResponse.next());
  }

  const cookie = req.cookies.get(GATE_COOKIE)?.value;
  if (cookie === required) return rootAware(req, NextResponse.next());

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "このデモは合言葉が必要です（/gate から入力）" }, { status: 401 });
  }

  // next にはパスだけでなくクエリも含める（2026-08-13 修正）。
  // mode/view/live 等の画面状態がURLに乗るようになったため、パスだけ渡すと
  // 合言葉入力後に共有URLの画面状態が失われる（常にトップへ戻ってしまう）
  const url = req.nextUrl.clone();
  const search = req.nextUrl.search; // "?a=b&c=d" または ""
  url.pathname = "/gate";
  url.search = "";
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
