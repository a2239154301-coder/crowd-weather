import { NextResponse } from "next/server";
import { listStaff, upsertStaff, type StaffState } from "@/lib/ops/store";
import { isValidZoneId } from "@/lib/ops/staffing";

/**
 * スタッフの入場・状態更新・一覧。
 *
 * 認証はデモ範囲では合言葉ゲート（middleware）に委ねる名前ベース。
 * 状態は3つだけ（onpost/moving/away）— 現場を複雑にしない（ユーザー要望 2026-08-13）。
 */

const STATES: StaffState[] = ["onpost", "moving", "away"];
const ROLES = ["water", "guide", "aid"] as const;

export async function GET() {
  return NextResponse.json({ staff: await listStaff() });
}

export async function POST(req: Request) {
  let body: {
    name?: unknown;
    role?: unknown;
    postCode?: unknown;
    zoneId?: unknown;
    state?: unknown;
    note?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 30) : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const role = ROLES.includes(body.role as (typeof ROLES)[number])
    ? (body.role as (typeof ROLES)[number])
    : "guide";
  const postCode = typeof body.postCode === "string" ? body.postCode.slice(0, 8) : "";
  const zoneId = typeof body.zoneId === "string" && isValidZoneId(body.zoneId) ? body.zoneId : "";
  if (!postCode || !zoneId) {
    return NextResponse.json({ error: "postCode and valid zoneId are required" }, { status: 400 });
  }
  const state = STATES.includes(body.state as StaffState) ? (body.state as StaffState) : "onpost";
  const note = typeof body.note === "string" ? body.note.slice(0, 60) : undefined;

  const staff = await upsertStaff({ name, role, postCode, zoneId, state, note });
  return NextResponse.json({ staff });
}
