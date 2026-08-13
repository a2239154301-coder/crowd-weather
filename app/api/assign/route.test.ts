import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * app/api/assign/route.ts の契約テスト（2026-08-13 新設）。
 *
 * このリポジトリで初めての app/api/**.test.ts。callOrca をモックし、LLMの出力に対する
 * 安全装置（validateAssignments 経由）がAPI層でも機能することを確認する。
 *
 * OrcaError は route.ts が `instanceof OrcaError` で判定するため、モックは実体を
 * 保持する必要がある（vi.importActual で実物を残し、callOrca だけ差し替える）。
 */

const { callOrca } = vi.hoisted(() => ({ callOrca: vi.fn() }));

vi.mock("@/lib/ai/orca", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/orca")>();
  return { ...actual, callOrca };
});

import { POST } from "./route";
import { OrcaError } from "@/lib/ai/orca";

function post(body: unknown): Request {
  return new Request("http://test/api/assign", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function fakeMeta() {
  return {
    task: "advice" as const,
    requestedModel: "orcarouter/cw-advice",
    servedModel: "orcarouter/cw-advice",
    fallbackLevel: 0,
    resolvedModel: null,
    router: null,
    usage: null,
    latencyMs: 1,
  };
}

function baseContext() {
  return {
    candidates: [
      { memberId: "s01", name: "佐藤", role: "guide", group: "メイン", fromCode: "", fromZoneId: "" },
      { memberId: "s12", name: "松本", role: "water", group: "給水", fromCode: "", fromZoneId: "" },
    ],
    vacantPosts: [
      { code: "C-1", zoneId: "main", zoneName: "メインステージ", at: { x: 0, y: 0 }, role: "guide" },
      { code: "D-1", zoneId: "shop", zoneName: "物販の列", at: { x: 0, y: 0 }, role: "water" },
    ],
  };
}

beforeEach(() => {
  callOrca.mockReset();
});

describe("POST /api/assign — 入力検証", () => {
  it("contextが無ければ400", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
  });

  it("candidatesが空配列なら400", async () => {
    const res = await POST(
      post({ context: { candidates: [], vacantPosts: baseContext().vacantPosts } })
    );
    expect(res.status).toBe(400);
  });

  it("vacantPostsが空配列なら400", async () => {
    const res = await POST(
      post({ context: { candidates: baseContext().candidates, vacantPosts: [] } })
    );
    expect(res.status).toBe(400);
  });

  it("candidates/vacantPostsが配列でなければ400", async () => {
    const res = await POST(post({ context: { candidates: "not-array", vacantPosts: [] } }));
    expect(res.status).toBe(400);
  });

  it("不正なJSON bodyは400", async () => {
    const req = new Request("http://test/api/assign", { method: "POST", body: "{not json" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/assign — LLM出力の安全装置", () => {
  it("架空のポストコードを返したら棄却されrejectedに数えられる", async () => {
    callOrca.mockResolvedValue({
      text: JSON.stringify({
        assignments: [{ staffName: "佐藤", toPostCode: "Z-99", reason: "テスト" }],
        note: "",
      }),
      meta: fakeMeta(),
    });
    const res = await POST(post({ context: baseContext(), situation: { hour: "15:00" } }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.assignments).toHaveLength(0);
    expect(json.rejected).toBe(1);
  });

  it("架空のスタッフ名を返したら棄却される", async () => {
    callOrca.mockResolvedValue({
      text: JSON.stringify({
        assignments: [{ staffName: "存在しない人", toPostCode: "C-1", reason: "テスト" }],
        note: "",
      }),
      meta: fakeMeta(),
    });
    const res = await POST(post({ context: baseContext() }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.assignments).toHaveLength(0);
    expect(json.rejected).toBe(1);
  });

  it("同じポストに2人割り当てたら2件目が棄却される", async () => {
    callOrca.mockResolvedValue({
      text: JSON.stringify({
        assignments: [
          { staffName: "佐藤", toPostCode: "C-1", reason: "1件目" },
          { staffName: "松本", toPostCode: "C-1", reason: "2件目" },
        ],
        note: "",
      }),
      meta: fakeMeta(),
    });
    const res = await POST(post({ context: baseContext() }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.assignments).toHaveLength(1);
    expect(json.rejected).toBe(1);
  });

  it("LLMの出力がJSONとしてパースできなければ502", async () => {
    callOrca.mockResolvedValue({ text: "not json{", meta: fakeMeta() });
    const res = await POST(post({ context: baseContext() }));
    expect(res.status).toBe(502);
  });

  it("assignmentsが配列でなければ502（オブジェクト等）", async () => {
    callOrca.mockResolvedValue({
      text: JSON.stringify({ assignments: { staffName: "佐藤" }, note: "" }),
      meta: fakeMeta(),
    });
    const res = await POST(post({ context: baseContext() }));
    expect(res.status).toBe(502);
  });

  it("assignmentsが欠落していても502（undefinedは配列ではない）", async () => {
    callOrca.mockResolvedValue({ text: JSON.stringify({ note: "提案なし" }), meta: fakeMeta() });
    const res = await POST(post({ context: baseContext() }));
    expect(res.status).toBe(502);
  });
});

describe("POST /api/assign — 正常系", () => {
  it("有効な提案がassignmentsとして返り、toZoneId/toZoneNameはvacantPostsから引かれる", async () => {
    callOrca.mockResolvedValue({
      text: JSON.stringify({
        assignments: [
          { staffName: "佐藤", toPostCode: "C-1", toZoneId: "no-such-zone", reason: "受付が近い" },
        ],
        note: "全体は落ち着いています",
      }),
      meta: fakeMeta(),
    });
    const res = await POST(post({ context: baseContext(), situation: { hour: "15:00", tempC: 33 } }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.assignments).toHaveLength(1);
    expect(json.assignments[0].toZoneId).toBe("main");
    expect(json.assignments[0].toZoneName).toBe("メインステージ");
    expect(json.rejected).toBe(0);
    expect(json.note).toBe("全体は落ち着いています");
    expect(json.meta).toBeDefined();
  });

  it("OrcaErrorはそのままstatusを返す", async () => {
    callOrca.mockRejectedValue(new OrcaError("timeout", 504));
    const res = await POST(post({ context: baseContext() }));
    expect(res.status).toBe(504);
  });
});

describe("POST /api/assign — 動的enum", () => {
  it("tool parametersのenumはリクエストのcandidates名・vacantPostsコードそのもの", async () => {
    callOrca.mockResolvedValue({
      text: JSON.stringify({ assignments: [], note: "" }),
      meta: fakeMeta(),
    });
    await POST(post({ context: baseContext() }));

    expect(callOrca).toHaveBeenCalledTimes(1);
    const callArgs = callOrca.mock.calls[0][0];
    const schema = callArgs.extras.tool.parameters;
    const itemProps = schema.properties.assignments.items.properties;
    expect(itemProps.staffName.enum).toEqual(["佐藤", "松本"]);
    expect(itemProps.toPostCode.enum).toEqual(["C-1", "D-1"]);
  });
});
