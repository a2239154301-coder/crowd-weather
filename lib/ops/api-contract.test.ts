import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * APIルートの**契約**テスト（2026-08-13 新設）。
 *
 * 既存191件は全て lib/ 配下の純関数で、`app/api/*\/route.ts` の入力検証と応答形は
 * 一度も自動検証されていなかった（画面とAPIの回帰が毎回人力）。
 *
 * ## 方式: HTTPサーバを立てない
 *
 * Next.js のルートハンドラは `export async function GET/POST/PATCH(req: Request)` の
 * 素の関数なので、直接importして `new Request(...)` を渡せば呼べる。
 * 返る NextResponse の `status` と `await res.json()` を検証する。
 * middleware（合言葉ゲート）は経由しないため、ここで見ているのは
 * **ハンドラ単体の契約**であることに注意。
 *
 * ## ⚠ Upstashへ実アクセスさせないための三重の防御
 *
 * `lib/ops/store.ts` は `UPSTASH_REDIS_REST_URL` / `_TOKEN` があると実Upstashへ書きに行く
 * （テストが本番データを汚す・ネットワークに依存する）。しかも `useUpstash` は
 * **モジュール評価時のトップレベルconst**なので、import後に環境変数を消しても手遅れになる。
 * よって:
 *
 *   (1) `vi.hoisted` で import より前に両env varを削除する（`useUpstash` が false で凍る）
 *   (2) `storeKind() === "memory"` を実行時アサートする（凍った結果を実測で確認）
 *   (3) グローバル `fetch` を投げるスタブに差し替える（万一 store が将来
 *       リクエスト時にenvを読む実装へ変わっても、無言のネットワークアクセスではなく
 *       声の大きいテスト失敗になる）
 *
 * `vi.mock` でストアごと差し替える手も取れるが、それだと
 * 「ルートとストアの結線」そのものが検証対象から外れるため、実ストア（in-memory）を使う。
 */

vi.hoisted(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

import { POST as staffPost, GET as staffGet } from "@/app/api/staff/route";
import { POST as dispatchPost, PATCH as dispatchPatch } from "@/app/api/dispatch/route";
import { GET as healthGet } from "@/app/api/health/route";
import { resetStoreForDemo, storeKind } from "@/lib/ops/store";

/** 名簿の実在メンバー（lib/data/roster.ts の静的23名） */
const ROSTER_GUIDE = "佐藤";
const ROSTER_RECEPTION = "林";
const ROSTER_WATER = "松本";
/** 名簿に無い名前（任意名で空レコードを作れないことの確認用） */
const UNKNOWN_NAME = "存在しない名前ZZZ";

/** VENUE.zones に実在するゾーンID */
const VALID_ZONE = "wg";
const INVALID_ZONE = "no-such-zone";

function post(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

function patch(url: string, body: unknown): Request {
  return new Request(url, { method: "PATCH", body: JSON.stringify(body) });
}

beforeAll(() => {
  // 防御(3): このファイルの3ルートは fetch を使わない。呼ばれたら異常。
  vi.stubGlobal("fetch", () => {
    throw new Error("network access is forbidden in api-contract tests");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // ストアは globalThis に吊るされており、テスト間で状態が残る。
  // 残すと「未入場のはず」の前提や health の counts が実行順に依存する
  resetStoreForDemo();
});

describe("ストアの隔離（前提条件）", () => {
  it("in-memory で動いている（Upstashへは絶対に行かない）", () => {
    expect(storeKind()).toBe("memory");
    expect(process.env.UPSTASH_REDIS_REST_URL).toBeUndefined();
    expect(process.env.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
  });

  it("fetch は封じられている（実アクセスがあれば必ず失敗する）", () => {
    expect(() => fetch("https://example.com")).toThrow(/network access is forbidden/);
  });
});

describe("POST /api/staff — 入場・状態更新の契約", () => {
  it("name が空なら 400", async () => {
    const res = await staffPost(post("http://localhost/api/staff", { name: "", zoneId: VALID_ZONE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name is required");
  });

  it("name が空白だけでも 400（trim後に空）", async () => {
    const res = await staffPost(post("http://localhost/api/staff", { name: "   ", zoneId: VALID_ZONE }));
    expect(res.status).toBe(400);
  });

  it("zoneId が不正なら 400（valid zoneId is required）", async () => {
    // ⚠ state は "onpost" にすること。postCode:"" zoneId:"" state:"away" は
    // presence登録として素通りするため、"away" だとこの検証を踏まない
    const res = await staffPost(
      post("http://localhost/api/staff", { name: ROSTER_GUIDE, zoneId: INVALID_ZONE, state: "onpost" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("valid zoneId is required");
  });

  it("zoneId が欠落していても 400", async () => {
    const res = await staffPost(post("http://localhost/api/staff", { name: ROSTER_GUIDE, state: "onpost" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("valid zoneId is required");
  });

  it("role が不正な値なら guide にフォールバックして 200", async () => {
    const res = await staffPost(
      post("http://localhost/api/staff", { name: ROSTER_GUIDE, role: "wizard", zoneId: VALID_ZONE })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).staff.role).toBe("guide");
  });

  it('role:"reception" が guide に化けない（08-13 修正の回帰防止）', async () => {
    const res = await staffPost(
      post("http://localhost/api/staff", {
        name: ROSTER_RECEPTION,
        role: "reception",
        zoneId: VALID_ZONE,
        postCode: "R-1",
        state: "onpost",
      })
    );
    expect(res.status).toBe(200);
    const { staff } = await res.json();
    expect(staff.role).toBe("reception");
    expect(staff.role).not.toBe("guide");
  });

  it("water / aid / guide も宣言どおり保持される", async () => {
    for (const role of ["water", "aid", "guide"] as const) {
      const res = await staffPost(
        post("http://localhost/api/staff", { name: ROSTER_WATER, role, zoneId: VALID_ZONE })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).staff.role).toBe(role);
    }
  });

  it("名簿メンバーの presence登録（postCode:\"\" zoneId:\"\" state:\"away\"）は 200", async () => {
    const res = await staffPost(
      post("http://localhost/api/staff", { name: ROSTER_GUIDE, postCode: "", zoneId: "", state: "away" })
    );
    expect(res.status).toBe(200);
    const { staff } = await res.json();
    expect(staff.name).toBe(ROSTER_GUIDE);
    expect(staff.state).toBe("away");
    expect(staff.zoneId).toBe("");
  });

  it("名簿に無い名前で同じ presence登録をすると 400（任意名で空レコードを作れない）", async () => {
    const res = await staffPost(
      post("http://localhost/api/staff", { name: UNKNOWN_NAME, postCode: "", zoneId: "", state: "away" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("valid zoneId is required");
  });

  it("壊れたJSONボディは 400", async () => {
    const res = await staffPost(
      new Request("http://localhost/api/staff", { method: "POST", body: "{ not json" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("GET は登録済みスタッフを返す", async () => {
    await staffPost(post("http://localhost/api/staff", { name: ROSTER_GUIDE, zoneId: VALID_ZONE }));
    const { staff } = await (await staffGet()).json();
    expect(staff).toHaveLength(1);
    expect(staff[0].name).toBe(ROSTER_GUIDE);
  });
});

describe("POST /api/dispatch — 指示配信の契約", () => {
  /** 指示の宛先として使える最小の有効ボディ */
  function dispatchBody(over: Record<string, unknown> = {}) {
    return { staffName: ROSTER_GUIDE, toZoneId: VALID_ZONE, action: "給水誘導", ...over };
  }

  it("staffName が無ければ 400", async () => {
    const res = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ staffName: "" })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("staffName and action are required");
  });

  it("action が無ければ 400", async () => {
    const res = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ action: "" })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("staffName and action are required");
  });

  it("存在しない zoneId は 400", async () => {
    const res = await dispatchPost(
      post("http://localhost/api/dispatch", dispatchBody({ toZoneId: INVALID_ZONE }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(INVALID_ZONE);
  });

  it("入場も名簿登録もされていない名前は 400（表記ゆれの指示が無言で消えない）", async () => {
    const res = await dispatchPost(
      post("http://localhost/api/dispatch", dispatchBody({ staffName: UNKNOWN_NAME }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(UNKNOWN_NAME);
  });

  it("名簿メンバーへは未入場でも 200（事前配置指示ができる）", async () => {
    // 誰も入場していない状態から始める
    const { staff } = await (await staffGet()).json();
    expect(staff).toHaveLength(0);

    const res = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ staffName: ROSTER_WATER })));
    expect(res.status).toBe(200);
    const { dispatch } = await res.json();
    expect(dispatch.staffName).toBe(ROSTER_WATER);
    expect(dispatch.status).toBe("sent");
    expect(dispatch.toZoneName).toBe("西ゲート");
  });

  it("入場済み（名簿外）の名前へも 200", async () => {
    await staffPost(post("http://localhost/api/staff", { name: UNKNOWN_NAME, zoneId: VALID_ZONE }));
    const res = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ staffName: UNKNOWN_NAME })));
    expect(res.status).toBe(200);
  });

  it('toPostCode "A-1" は書式検証を通る', async () => {
    const res = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ toPostCode: "A-1" })));
    expect(res.status).toBe(200);
    expect((await res.json()).dispatch.toPostCode).toBe("A-1");
  });

  it('toPostCode "xx" / "A-999" は 400にせず黙って無視する', async () => {
    for (const bad of ["xx", "A-999", "a-1", "1-A", ""]) {
      const res = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ toPostCode: bad })));
      expect(res.status).toBe(200);
      // undefined は JSON化で欠落する（null ではなくキーごと消える）
      expect((await res.json()).dispatch.toPostCode).toBeUndefined();
    }
  });

  it("urgency は now 以外すべて soon に丸められる", async () => {
    const now = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ urgency: "now" })));
    expect((await now.json()).dispatch.urgency).toBe("now");
    const junk = await dispatchPost(post("http://localhost/api/dispatch", dispatchBody({ urgency: "URGENT!!" })));
    expect((await junk.json()).dispatch.urgency).toBe("soon");
  });

  it("壊れたJSONボディは 400", async () => {
    const res = await dispatchPost(
      new Request("http://localhost/api/dispatch", { method: "POST", body: "<html>" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });
});

describe("PATCH /api/dispatch — 状態遷移の契約", () => {
  it("存在しないidは 404", async () => {
    // status は有効値にすること。不正statusだと store照会の前に 400 で短絡し、別の分岐を見てしまう
    const res = await dispatchPatch(patch("http://localhost/api/dispatch", { id: "d-not-exist", status: "arrived" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("dispatch not found");
  });

  it("id が空、または status が不正なら 400", async () => {
    const noId = await dispatchPatch(patch("http://localhost/api/dispatch", { id: "", status: "arrived" }));
    expect(noId.status).toBe(400);
    const badStatus = await dispatchPatch(patch("http://localhost/api/dispatch", { id: "d-x", status: "teleported" }));
    expect(badStatus.status).toBe(400);
  });

  it("実在する指示は状態が遷移する", async () => {
    const created = await dispatchPost(
      post("http://localhost/api/dispatch", { staffName: ROSTER_GUIDE, toZoneId: VALID_ZONE, action: "移動" })
    );
    const { dispatch } = await created.json();
    expect(dispatch.status).toBe("sent");

    const res = await dispatchPatch(patch("http://localhost/api/dispatch", { id: dispatch.id, status: "arrived" }));
    expect(res.status).toBe(200);
    expect((await res.json()).dispatch.status).toBe("arrived");
  });
});

describe("GET /api/health — 診断の契約と秘密の非漏洩", () => {
  it("store / persistent / gate / counts のキーが揃っている", async () => {
    const body = await (await healthGet()).json();
    expect(body.store).toBe("memory");
    expect(body.persistent).toBe(false);
    expect(["on", "off"]).toContain(body.gate);
    expect(body.counts).toEqual({ staff: 0, reports: 0, dispatches: 0 });
  });

  it("counts が実際の登録件数を反映する", async () => {
    await staffPost(post("http://localhost/api/staff", { name: ROSTER_GUIDE, zoneId: VALID_ZONE }));
    await dispatchPost(
      post("http://localhost/api/dispatch", { staffName: ROSTER_GUIDE, toZoneId: VALID_ZONE, action: "移動" })
    );
    const body = await (await healthGet()).json();
    expect(body.counts).toEqual({ staff: 1, reports: 0, dispatches: 1 });
  });

  it("合言葉の**値**を返さない（gate は on/off だけ）", async () => {
    const secret = "SENTINEL-passphrase-9f3a7c";
    vi.stubEnv("DEMO_ACCESS_KEY", secret);
    const res = await healthGet();
    const body = await res.json();
    expect(body.gate).toBe("on");
    expect(JSON.stringify(body)).not.toContain(secret);
    vi.unstubAllEnvs();
  });

  it("応答にURL・トークンらしき文字列が一切含まれない", async () => {
    const raw = JSON.stringify(await (await healthGet()).json());
    expect(raw).not.toMatch(/https?:\/\//i);
    expect(raw).not.toMatch(/UPSTASH/i);
    expect(raw).not.toMatch(/token|bearer|api[-_]?key|secret|password/i);
  });

  it("応答のキー集合が固定されている（将来の項目追加で秘密が混入しない防波堤）", async () => {
    const body = await (await healthGet()).json();
    expect(Object.keys(body).sort()).toEqual(["counts", "gate", "persistent", "store", "warning"]);
    expect(Object.keys(body.counts).sort()).toEqual(["dispatches", "reports", "staff"]);
  });
});
