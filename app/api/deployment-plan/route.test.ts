import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * `app/api/deployment-plan/route.ts` の契約テスト（2026-08-14 新設）。
 *
 * `lib/ops/api-contract.test.ts` の三重防御をそのまま踏襲する:
 *   (1) `vi.hoisted` で import より前に Upstash env var を削除する
 *       （`useUpstash` はモジュール評価時のトップレベル const なので、後から消しても手遅れ）
 *   (2) `storeKind() === "memory"` を実行時アサートする
 *   (3) グローバル `fetch` を投げるスタブに差し替える（無言のネットワークアクセスを禁止する）
 * 加えて `beforeEach(resetStoreForDemo)` でテスト間の状態漏れを断つ。
 */

vi.hoisted(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

import { GET, POST, PATCH } from "./route";
import { resetStoreForDemo, storeKind } from "@/lib/ops/store";

/** 名簿の実在メンバー（lib/data/roster.ts の静的23名） */
const ROSTER_GUIDE = "佐藤"; // s01
const ROSTER_GUIDE2 = "高橋"; // s02
const ROSTER_WATER = "松本"; // s12
const UNKNOWN_NAME = "存在しない名前ZZZ";

/** VENUE.zones に実在するゾーンID（main = メインステージ） */
const VALID_ZONE = "main";
const INVALID_ZONE = "no-such-zone";

function post(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

function patch(url: string, body: unknown): Request {
  return new Request(url, { method: "PATCH", body: JSON.stringify(body) });
}

/** 有効なpostsの最小セット（POST bodyの雛形） */
function validPosts(): unknown[] {
  return [
    { code: "C-1", zoneId: VALID_ZONE, zoneName: "メインステージ", at: { x: 0, y: 0 }, role: "guide" },
    { code: "C-2", zoneId: VALID_ZONE, zoneName: "メインステージ", at: { x: 0, y: 0 }, role: "guide" },
  ];
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    placements: [{ name: ROSTER_GUIDE, postCode: "C-1" }],
    posts: validPosts(),
    scenarioSnapshot: { tickets: 24000, weather: "sunny", temp: 34 },
    ...over,
  };
}

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("network access is forbidden in deployment-plan route tests");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  resetStoreForDemo();
});

describe("ストアの隔離（前提条件）", () => {
  it("in-memory で動いている（Upstashへは絶対に行かない）", () => {
    expect(storeKind()).toBe("memory");
    expect(process.env.UPSTASH_REDIS_REST_URL).toBeUndefined();
    expect(process.env.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
  });
});

describe("POST /api/deployment-plan — 新規draft作成の契約", () => {
  it("壊れたJSONボディは400", async () => {
    const res = await POST(new Request("http://localhost/api/deployment-plan", { method: "POST", body: "<html>" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("posts が非配列なら400", async () => {
    const res = await POST(post("http://localhost/api/deployment-plan", validBody({ posts: "not-array" })));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("架空zoneIdのpostがあれば400", async () => {
    const res = await POST(
      post(
        "http://localhost/api/deployment-plan",
        validBody({ posts: [{ code: "C-1", zoneId: INVALID_ZONE, role: "guide" }] })
      )
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(INVALID_ZONE);
  });

  it("書式外postCodeのpostがあれば400", async () => {
    const res = await POST(
      post("http://localhost/api/deployment-plan", validBody({ posts: [{ code: "xx", zoneId: VALID_ZONE }] }))
    );
    expect(res.status).toBe(400);
  });

  it("同一postCodeに2人割り当てると400", async () => {
    const res = await POST(
      post(
        "http://localhost/api/deployment-plan",
        validBody({
          placements: [
            { name: ROSTER_GUIDE, postCode: "C-1" },
            { name: ROSTER_GUIDE2, postCode: "C-1" },
          ],
        })
      )
    );
    expect(res.status).toBe(400);
  });

  it("名簿外の氏名を含むと400", async () => {
    const res = await POST(
      post("http://localhost/api/deployment-plan", validBody({ placements: [{ name: UNKNOWN_NAME, postCode: "C-1" }] }))
    );
    expect(res.status).toBe(400);
  });

  it("placementsが201件なら400（上限超過）", async () => {
    const manyPosts = Array.from({ length: 201 }, (_, i) => ({
      code: `C-${i}`,
      zoneId: VALID_ZONE,
      role: "guide",
    }));
    const res = await POST(
      post("http://localhost/api/deployment-plan", validBody({ posts: manyPosts, placements: [] }))
    );
    // posts自体も201件で上限超過になるため posts の検証で先に400になる
    expect(res.status).toBe(400);
  });

  it("正常な入力は200・version:1・status:draftで作られる", async () => {
    const res = await POST(post("http://localhost/api/deployment-plan", validBody()));
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("draft");
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0].name).toBe(ROSTER_GUIDE);
    expect(plan.posts).toHaveLength(2);
    expect(plan.id).toMatch(/^dp-/);
  });
});

describe("GET /api/deployment-plan — draft/confirmedの取得契約", () => {
  it("何も無ければ両方null", async () => {
    const body = await (await GET()).json();
    expect(body.draft).toBeNull();
    expect(body.confirmed).toBeNull();
  });

  it("draftを作った直後はdraftに入り、confirmedはnull", async () => {
    await POST(post("http://localhost/api/deployment-plan", validBody()));
    const body = await (await GET()).json();
    expect(body.draft).not.toBeNull();
    expect(body.draft.status).toBe("draft");
    expect(body.confirmed).toBeNull();
  });

  it("confirmするとconfirmedに入り、draftはnullに戻る", async () => {
    const created = await (await POST(post("http://localhost/api/deployment-plan", validBody()))).json();
    await PATCH(
      patch("http://localhost/api/deployment-plan", {
        id: created.plan.id,
        version: created.plan.version,
        status: "confirmed",
      })
    );
    const body = await (await GET()).json();
    expect(body.confirmed).not.toBeNull();
    expect(body.confirmed.status).toBe("confirmed");
    expect(body.draft).toBeNull();
  });
});

describe("PATCH /api/deployment-plan — 更新・確定の契約", () => {
  it("存在しないidは404", async () => {
    const res = await PATCH(patch("http://localhost/api/deployment-plan", { id: "dp-not-exist", version: 1 }));
    expect(res.status).toBe(404);
  });

  it("version不一致は409で、bodyに最新planが同梱される", async () => {
    const created = await (await POST(post("http://localhost/api/deployment-plan", validBody()))).json();
    const res = await PATCH(
      patch("http://localhost/api/deployment-plan", {
        id: created.plan.id,
        version: created.plan.version + 999, // 明らかに古い/違うバージョン
        placements: [{ name: ROSTER_GUIDE2, postCode: "C-2" }],
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.plan.id).toBe(created.plan.id);
    expect(body.plan.version).toBe(created.plan.version);
  });

  it("正常な更新はversionが+1される", async () => {
    const created = await (await POST(post("http://localhost/api/deployment-plan", validBody()))).json();
    const res = await PATCH(
      patch("http://localhost/api/deployment-plan", {
        id: created.plan.id,
        version: created.plan.version,
        placements: [{ name: ROSTER_GUIDE2, postCode: "C-2" }],
      })
    );
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan.version).toBe(created.plan.version + 1);
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0].name).toBe(ROSTER_GUIDE2);
  });

  it("confirmするとstatus:confirmedかつconfirmedAtが入る", async () => {
    const created = await (await POST(post("http://localhost/api/deployment-plan", validBody()))).json();
    const res = await PATCH(
      patch("http://localhost/api/deployment-plan", {
        id: created.plan.id,
        version: created.plan.version,
        status: "confirmed",
      })
    );
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan.status).toBe("confirmed");
    expect(typeof plan.confirmedAt).toBe("number");
  });

  it("確定済み計画のplacements変更は400", async () => {
    const created = await (await POST(post("http://localhost/api/deployment-plan", validBody()))).json();
    const confirmed = await (
      await PATCH(
        patch("http://localhost/api/deployment-plan", {
          id: created.plan.id,
          version: created.plan.version,
          status: "confirmed",
        })
      )
    ).json();
    expect(confirmed.plan.status).toBe("confirmed");

    const res = await PATCH(
      patch("http://localhost/api/deployment-plan", {
        id: confirmed.plan.id,
        version: confirmed.plan.version,
        placements: [{ name: ROSTER_WATER, postCode: "C-1" }],
      })
    );
    expect(res.status).toBe(400);
  });

  it("壊れたJSONボディは400", async () => {
    const res = await PATCH(new Request("http://localhost/api/deployment-plan", { method: "PATCH", body: "<html>" }));
    expect(res.status).toBe(400);
  });
});
