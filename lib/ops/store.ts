import type { PostRole } from "./staffing";

/**
 * 当日運用のserver-side store — スタッフ・報告・指示の置き場。
 *
 * 2026-08-13 新設。既定は**in-memory**（`next dev` は単一プロセスなので完全動作。
 * デモ動画はローカルで撮る前提）。`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
 * があれば Upstash REST に自動切替し、Vercel本番の複数インスタンスでも共有される
 * （ユーザー決定 2026-08-13: in-memoryで作りUpstashは後付け可能に）。
 *
 * 設計メモ:
 * - in-memory は `globalThis` に吊るす（Next.js のHMRでモジュールが再評価されても消えない）
 * - Upstash はコレクションごとのJSON塊をGET/SETする素朴な方式（数十件のデモ規模なら十分。
 *   本格運用でリスト構造に変えるのはこの層の中だけで済む）
 * - 認証・認可はデモ範囲では合言葉ゲート（middleware）に委ねる。本認証はロードマップ
 */

export type StaffState = "onpost" | "moving" | "away";

export type Staff = {
  name: string;
  role: PostRole;
  /** いま割り当てられているポストコード（例 A-1）。指示で移動すると変わる */
  postCode: string;
  zoneId: string;
  state: StaffState;
  /** 離脱理由など（任意） */
  note?: string;
  /** 最終更新（ms epoch）。15分更新が無ければ配置ボードで「状態が古い」扱い */
  updatedAt: number;
};

export type ReportKind = "crowd" | "heat" | "trouble";

export type Report = {
  id: string;
  name: string;
  zoneId: string;
  kind: ReportKind;
  /** 1-5（ボタン報告）。自由文由来は構造化結果の重篤度 */
  level: number;
  /** 原文（自由文のとき）。ボタン報告は空 */
  text: string;
  /** 表示用の一言（自由文はLLM構造化の要約、ボタンは定型文） */
  summary: string;
  /** 由来。ナウキャストの信頼度重みに使う */
  source: "staff-button" | "staff-text";
  at: number;
};

export type DispatchStatus = "sent" | "moving" | "arrived" | "cancelled";

export type Dispatch = {
  id: string;
  staffName: string;
  fromCode: string;
  toZoneId: string;
  toZoneName: string;
  /**
   * 移動先の配置ポストコード（例 "B-1"）。表示と、スタッフの着任時にポストを確定するために使う。
   * ゾーンの実在検証は従来どおり toZoneId が担い、これは表示用の任意項目
   */
  toPostCode?: string;
  action: string;
  urgency: "now" | "soon";
  reason: string;
  status: DispatchStatus;
  createdAt: number;
  updatedAt: number;
};

type StoreShape = {
  staff: Map<string, Staff>;
  reports: Report[];
  dispatches: Dispatch[];
};

const g = globalThis as unknown as { __cwOpsStore?: StoreShape };

function mem(): StoreShape {
  if (!g.__cwOpsStore) {
    g.__cwOpsStore = { staff: new Map(), reports: [], dispatches: [] };
  }
  return g.__cwOpsStore;
}

// ── Upstash REST（環境変数があるときだけ） ──────────────────────────

const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = Boolean(UP_URL && UP_TOKEN);

async function upGet<T>(key: string): Promise<T | null> {
  const res = await fetch(`${UP_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UP_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result: string | null };
  return data.result ? (JSON.parse(data.result) as T) : null;
}

async function upSet(key: string, value: unknown): Promise<void> {
  await fetch(`${UP_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

// ── 公開API（in-memory / Upstash を透過的に切替） ────────────────────

export async function listStaff(): Promise<Staff[]> {
  if (useUpstash) return (await upGet<Staff[]>("cw:staff")) ?? [];
  return [...mem().staff.values()];
}

export async function upsertStaff(s: Omit<Staff, "updatedAt">): Promise<Staff> {
  const full: Staff = { ...s, updatedAt: Date.now() };
  if (useUpstash) {
    const all = ((await upGet<Staff[]>("cw:staff")) ?? []).filter((x) => x.name !== s.name);
    all.push(full);
    await upSet("cw:staff", all);
  } else {
    mem().staff.set(s.name, full);
  }
  return full;
}

export async function listReports(sinceMs?: number): Promise<Report[]> {
  const all = useUpstash ? ((await upGet<Report[]>("cw:reports")) ?? []) : mem().reports;
  const filtered = sinceMs ? all.filter((r) => r.at > sinceMs) : all;
  return [...filtered].sort((a, b) => b.at - a.at);
}

export async function addReport(r: Omit<Report, "id" | "at">): Promise<Report> {
  const full: Report = { ...r, id: `r-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, at: Date.now() };
  if (useUpstash) {
    const all = (await upGet<Report[]>("cw:reports")) ?? [];
    all.push(full);
    await upSet("cw:reports", all.slice(-200));
  } else {
    mem().reports.push(full);
    if (mem().reports.length > 200) mem().reports.splice(0, mem().reports.length - 200);
  }
  return full;
}

export async function listDispatches(staffName?: string): Promise<Dispatch[]> {
  const all = useUpstash ? ((await upGet<Dispatch[]>("cw:dispatches")) ?? []) : mem().dispatches;
  const filtered = staffName ? all.filter((d) => d.staffName === staffName) : all;
  return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
}

export async function addDispatch(
  d: Omit<Dispatch, "id" | "status" | "createdAt" | "updatedAt">
): Promise<Dispatch> {
  const now = Date.now();
  const full: Dispatch = {
    ...d,
    id: `d-${now}-${Math.floor(Math.random() * 1e6)}`,
    status: "sent",
    createdAt: now,
    updatedAt: now,
  };
  if (useUpstash) {
    const all = (await upGet<Dispatch[]>("cw:dispatches")) ?? [];
    all.push(full);
    await upSet("cw:dispatches", all.slice(-200));
  } else {
    mem().dispatches.push(full);
    if (mem().dispatches.length > 200) mem().dispatches.splice(0, mem().dispatches.length - 200);
  }
  return full;
}

export async function updateDispatch(id: string, status: DispatchStatus): Promise<Dispatch | null> {
  if (useUpstash) {
    const all = (await upGet<Dispatch[]>("cw:dispatches")) ?? [];
    const hit = all.find((d) => d.id === id);
    if (!hit) return null;
    hit.status = status;
    hit.updatedAt = Date.now();
    await upSet("cw:dispatches", all);
    return hit;
  }
  const hit = mem().dispatches.find((d) => d.id === id);
  if (!hit) return null;
  hit.status = status;
  hit.updatedAt = Date.now();
  return hit;
}

/** デモ用の初期化（開発時のみ想定。API経由では呼ばない） */
export function resetStoreForDemo(): void {
  g.__cwOpsStore = { staff: new Map(), reports: [], dispatches: [] };
}
