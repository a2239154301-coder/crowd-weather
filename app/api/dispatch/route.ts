import { NextResponse } from "next/server";
import {
  addDispatch,
  listDispatches,
  updateDispatch,
  type DispatchStatus,
} from "@/lib/ops/store";
import { isValidZoneId, zoneById } from "@/lib/ops/staffing";

/**
 * 指示の配信と状態遷移。
 *
 * POST = **人間（指示者）が承認した指示だけ**がここに来る。AIの提案はこのAPIを
 * 直接呼べない（調整コンソールの承認ボタンが唯一の入口。AIは提案まで — CLAUDE.md改訂ルール）。
 * PATCH = スタッフ側の状態遷移（moving=移動します / arrived=着きました）と指示者の取消。
 */

const STATUSES: DispatchStatus[] = ["sent", "moving", "arrived", "cancelled"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? undefined;
  return NextResponse.json({ dispatches: await listDispatches(name || undefined) });
}

export async function POST(req: Request) {
  let body: {
    staffName?: unknown;
    fromCode?: unknown;
    toZoneId?: unknown;
    action?: unknown;
    urgency?: unknown;
    reason?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const staffName = typeof body.staffName === "string" ? body.staffName.trim().slice(0, 30) : "";
  const toZoneId = typeof body.toZoneId === "string" ? body.toZoneId : "";
  const action = typeof body.action === "string" ? body.action.trim().slice(0, 80) : "";
  if (!staffName || !action) {
    return NextResponse.json({ error: "staffName and action are required" }, { status: 400 });
  }
  // ゾーンIDはenum相当の実在チェック（AI提案由来でも、ここが最終防衛線）
  if (!isValidZoneId(toZoneId)) {
    return NextResponse.json({ error: `unknown zoneId: ${toZoneId}` }, { status: 400 });
  }

  const dispatch = await addDispatch({
    staffName,
    fromCode: typeof body.fromCode === "string" ? body.fromCode.slice(0, 8) : "",
    toZoneId,
    toZoneName: zoneById(toZoneId)?.name ?? toZoneId,
    action,
    urgency: body.urgency === "now" ? "now" : "soon",
    reason: typeof body.reason === "string" ? body.reason.slice(0, 120) : "",
  });
  return NextResponse.json({ dispatch });
}

export async function PATCH(req: Request) {
  let body: { id?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const status = STATUSES.includes(body.status as DispatchStatus)
    ? (body.status as DispatchStatus)
    : null;
  if (!id || !status) {
    return NextResponse.json({ error: "id and valid status are required" }, { status: 400 });
  }
  const dispatch = await updateDispatch(id, status);
  if (!dispatch) return NextResponse.json({ error: "dispatch not found" }, { status: 404 });
  return NextResponse.json({ dispatch });
}
