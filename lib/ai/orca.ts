/**
 * OrcaRouter を呼ぶ唯一の口。
 *
 * ここに集約する理由:
 *   1. 「タスクごとに適材適所でモデルを切り替える」方針を1箇所で持つため
 *      （定型処理は速く安いモデル、判断・起草は上位モデル ＝ 審査項目⑥の実装）
 *   2. 使用モデル・トークン数を必ず回収し、実測原価を出せる状態を保つため
 *   3. APIキーがサーバー側から出ないことを、この1ファイルを見れば検証できるようにするため
 *
 * docs: /getting-started/quickstart, /routing/auto-router, /routing/response-headers
 */

const ORCA_BASE = "https://api.orcarouter.ai/v1";
const TIMEOUT_MS = 30_000;

/** LLMを呼ぶ用途。CROWD WEATHER では この3つ「だけ」がLLMを使う。 */
export type OrcaTask =
  | "advice" // 予報値 → 運営判断の言語化（イベント中・数回）
  | "ingest" // 会場図面・過去計画書の読解 → 初期モデル生成（会場ごと1回）
  | "plan"; // 雑踏警備計画書の起草（イベントごと数回）

type RoutingPolicy = {
  model: string;
  /** primary が落ちたら順に試す候補 */
  fallbacks: string[];
  temperature: number;
  maxTokens: number;
};

/**
 * タスク → ルーティング方針。**2026-08-09 の実測（scripts/bench.mjs）に基づく。**
 *
 * なぜ orcarouter/auto を使わないか:
 *   auto の既定戦略は cheapest。実測では qwen/qwen3.7-plus に解決し、
 *   **45.96秒 / 出力2,620トークン**を消費した（最安モデルが推論モデルだったため）。
 *   同じプロンプトで google/gemini-2.5-flash-lite は 2.48秒 / 342トークン。
 *   「トークン単価が最安」＝「1リクエストの総コストが最安」ではない、というのが実測の結論。
 *
 * max_tokens の注意:
 *   推論モデルは thinking でトークンを使い切り、**本文が0字で返る**ことがある
 *   （実測: openai/gpt-5-mini・deepseek/deepseek-v4-flash がいずれも本文0字）。
 *   エラーにならないので、モデルを差し替えたら必ず bench.mjs で本文字数を確認すること。
 *
 * TODO: ダッシュボードで名前付きルーターを作ったら `orcarouter/<name>` に差し替える。
 *   コードを触らずに方針を変えられるようになる。docs: /routing/named-routers
 */
const ROUTING: Record<OrcaTask, RoutingPolicy> = {
  // 実測 2.48秒。イベント中に何度も押されるので速度優先。
  advice: {
    model: "google/gemini-2.5-flash-lite",
    fallbacks: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5"],
    temperature: 0.2,
    maxTokens: 1500,
  },
  // 会場ごと1回きり。Vision と Structured Outputs が要るので品質優先。
  // TODO(優先01): 実装時に bench.mjs へ vision ケースを足して実測する。
  ingest: {
    model: "google/gemini-2.5-pro",
    fallbacks: ["openai/gpt-4o"],
    temperature: 0,
    maxTokens: 4000,
  },
  // 計画書の起草。実測18.7秒だが最も詳細（760字）。速度より文章品質。
  plan: {
    model: "anthropic/claude-sonnet-4.6",
    fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash"],
    temperature: 0.3,
    maxTokens: 4000,
  },
};

export type OrcaUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** ルーティングの根拠。ブラックボックスにせず、そのまま画面に出す。 */
export type OrcaMeta = {
  task: OrcaTask;
  /** 方針上の第一候補 */
  requestedModel: string;
  /** 実際に応答したモデル（フォールバックした場合は候補2以降） */
  servedModel: string;
  /** 0 = 第一候補が成功。1以上 = 何段目のフォールバックが応答したか */
  fallbackLevel: number;
  /** orcarouter/{name} を呼んだときだけ入る（X-Orca-Resolved-Model） */
  resolvedModel: string | null;
  router: string | null;
  usage: OrcaUsage | null;
  latencyMs: number;
};

export type OrcaResult = { text: string; meta: OrcaMeta };

export class OrcaError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "OrcaError";
  }
}

/**
 * 次の候補モデルを試すべきエラーか。
 * 上流の一時障害・過負荷・到達不能・チャネル解決失敗を対象にする。
 * 400（プロンプト自体が不正）は何度試しても同じなので retry しない。
 */
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

type ChatCompletion = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: OrcaUsage;
  error?: { message?: string };
};

async function attempt(
  model: string,
  policy: RoutingPolicy,
  args: { system: string; user: string },
  apiKey: string
): Promise<{ text: string; usage: OrcaUsage | null; resolvedModel: string | null; router: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ORCA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        temperature: policy.temperature,
        max_tokens: policy.maxTokens,
      }),
    });

    const data = (await res.json()) as ChatCompletion;
    if (!res.ok) {
      throw new OrcaError(
        data?.error?.message || `OrcaRouter request failed (${res.status})`,
        res.status
      );
    }

    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? null,
      // X-Orca-* ヘッダ = どう振り分けられたかの根拠 (docs: /routing/response-headers)
      resolvedModel: res.headers.get("x-orca-resolved-model"),
      router: res.headers.get("x-orca-router"),
    };
  } catch (error) {
    if (error instanceof OrcaError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new OrcaError(`${model} timed out after ${TIMEOUT_MS}ms`, 504);
    }
    throw new OrcaError(`Failed to reach OrcaRouter (${model})`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * フォールバックはアプリ側で実装している。
 *
 * 理由: OrcaRouter の `models` + `route:"fallback"`（docs: /routing/model-fallbacks）を
 * 生HTTPで検証したところ、`extra_body` のネスト・トップレベルのどちらの形でも
 * **鎖を付けない場合と挙動が変わらなかった**（2026-08-09実測。存在しないモデル名・
 * 存在しないルーター名のどちらでも次候補へ切り替わらず、同じエラーが返った）。
 * ゲートウェイ側の機能を否定するものではないが、**デモ当日の可用性を検証できない仕組みに
 * 依存させない**ため、自前のループにした。これはテストできる（scripts/bench.mjs 参照）。
 */
export async function callOrca(args: {
  task: OrcaTask;
  system: string;
  user: string;
}): Promise<OrcaResult> {
  const apiKey = process.env.ORCAROUTER_API_KEY;
  if (!apiKey) {
    throw new OrcaError("ORCAROUTER_API_KEY is not configured", 500);
  }

  const policy = ROUTING[args.task];
  const chain = [policy.model, ...policy.fallbacks];
  const t0 = Date.now();
  let lastError: OrcaError = new OrcaError("No model candidates configured", 500);

  for (let level = 0; level < chain.length; level++) {
    const model = chain[level];
    try {
      const r = await attempt(model, policy, args, apiKey);
      return {
        text: r.text,
        meta: {
          task: args.task,
          requestedModel: policy.model,
          servedModel: model,
          fallbackLevel: level,
          resolvedModel: r.resolvedModel,
          router: r.router,
          usage: r.usage,
          latencyMs: Date.now() - t0,
        },
      };
    } catch (error) {
      lastError = error instanceof OrcaError ? error : new OrcaError("Unexpected error", 500);
      const isLast = level === chain.length - 1;
      if (isLast || !isRetryable(lastError.status)) throw lastError;
      console.warn(
        `[orca] ${model} failed (${lastError.status}: ${lastError.message}). Falling back to ${chain[level + 1]}`
      );
    }
  }

  throw lastError;
}

/** モデルIDの実在確認用（deckとdocsで記載が食い違うため、実装前に必ず1回叩く） */
export async function listModels(): Promise<string[]> {
  const apiKey = process.env.ORCAROUTER_API_KEY;
  if (!apiKey) throw new OrcaError("ORCAROUTER_API_KEY is not configured", 500);

  const res = await fetch(`${ORCA_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new OrcaError(`Failed to list models (${res.status})`, res.status);

  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id);
}
