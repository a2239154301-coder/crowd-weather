import { NextResponse } from "next/server";
import { listDispatches, listReports, listStaff, storeKind } from "@/lib/ops/store";

/**
 * 運用の健康診断（2026-08-13 新設）。デモ・撮影の前にここを見る。
 *
 * なぜ要るか: 状態ストアが in-memory のまま本番URL（Vercel serverless）で
 * スタッフ導線を使うと、関数インスタンスごとにメモリが分かれるため
 * 「入場したのに配置ボードに出ない」が**エラーを出さずに**起きる。
 * 無言の失敗を、事前に見える失敗に変えるための窓口。
 *
 * ⚠ 秘密情報は返さない。ストアの**種別**と件数だけ（URL・トークン・合言葉の値は返さない）。
 * このエンドポイント自体も middleware の合言葉ゲートの内側にある。
 */
export async function GET() {
  const kind = storeKind();
  const [staff, reports, dispatches] = await Promise.all([
    listStaff(),
    listReports(),
    listDispatches(),
  ]);
  return NextResponse.json({
    store: kind,
    persistent: kind === "upstash",
    // ゲートが有効かどうか（値は返さない）。本番で無防備になっていないかの確認用
    gate: process.env.DEMO_ACCESS_KEY ? "on" : "off",
    counts: { staff: staff.length, reports: reports.length, dispatches: dispatches.length },
    warning:
      kind === "memory"
        ? "メモリ保存です。本番URL（Vercel）ではスタッフ導線が安定しません。ローカルデモなら問題ありません"
        : null,
  });
}
