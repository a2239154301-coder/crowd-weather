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

/**
 * LLMを呼ぶ用途。CROWD WEATHER の設計上のLLM用途は3系統
 * （①読解 ②文書起草 ③言語化・解釈）で、whatif は③の一員
 * （自然言語→シナリオ差分の翻訳。予測計算はしない）。
 */
export type OrcaTask =
  | "advice" // 予報値 → 運営判断の言語化（イベント中・数回）
  | "whatif" // 「もし〜だったら?」→ シナリオ差分JSONへの翻訳（advice系・頻繁）
  | "ingest" // 会場図面・過去計画書の読解 → 初期モデル生成（会場ごと1回）
  | "plan"; // 雑踏警備計画書の起草（イベントごと数回）

export type RoutingPolicy = {
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
export const ROUTING: Record<OrcaTask, RoutingPolicy> = {
  // 2026-08-13、名前付きルーター orcarouter/cw-advice に切り替え済み
  // （scripts/router-check.mjs で3回合格。基準1744msに対し1210〜2329ms、
  // X-Orca-Router/X-Orca-Resolved-Model とも一貫して返ることを確認）。
  // 許可モデルはダッシュボード側で下記3つに絞ってあり、戦略は「最安値優先」。
  // fallbacks はルーターそのものが不通のときの保険として直接指定を残す。
  advice: {
    model: "orcarouter/cw-advice",
    fallbacks: ["google/gemini-2.5-flash-lite", "openai/gpt-4o-mini", "anthropic/claude-haiku-4.5"],
    temperature: 0.2,
    maxTokens: 1500,
  },
  // 自然言語→シナリオ差分の翻訳。flash-lite では解釈を取りこぼす
  // （実測2026-08-11: 「無風」のwindMs変換漏れ・「半分」の乗算不能が3問中2問）。
  // gpt-4.1 は指示追従が安定（当初候補の gpt-4o-mini から差し替え済み）。
  whatif: {
    model: "openai/gpt-4.1",
    fallbacks: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash-lite"],
    temperature: 0,
    maxTokens: 800,
  },
  // 会場ごと1回きり。Vision と Structured Outputs が要るので品質優先。
  // ただし本番は Vercel Hobby の60秒上限内で完走することが絶対条件。
  //
  // 実測(2026-08-11、1024px JPEG・ゾーン上限8件の指示つき):
  //   openai/gpt-4.1                8.1秒  zones 8 / buildings 4  確信度high ← 採用
  //   openai/gpt-4o                 6.9秒  zones 3〜4             粗い。第一フォールバック
  //   google/gemini-2.5-flash-lite  9.0秒  zones 8                座標が雑（全面を覆うゾーンを作る）。
  //                                        OpenAI障害時の最終フォールバック
  //   google/gemini-2.5-pro         54〜77秒                      粒度は最良だが thinking が4,600〜5,700tok
  //                                        あり60秒に収まらない。不採用
  //   google/gemini-2.5-flash       52〜58秒  thinking 8,072tok   不採用
  //   qwen/qwen3-vl-235b-instruct   57.5秒                        不採用
  //
  // ⚠ Gemini の thinking は絞れない（2026-08-11実測）。
  //   公式docsにある reasoning_effort フィールドは low/minimal とも無効
  //   （reasoning トークン数が全く変わらない）。`-low` サフィックスは
  //   model_not_found (503)。docsにある機能がこのデプロイには実装されていない。
  //   画像を1672px→768pxに縮小しても入力トークンは 2421→2287 でほぼ不変
  //   （時間の支配項は thinking と出力生成であり、画像サイズではない）。
  ingest: {
    model: "openai/gpt-4.1",
    fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash-lite"],
    temperature: 0,
    maxTokens: 8000,
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
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: OrcaUsage;
  error?: { message?: string };
};

/** 画像入力・構造化出力を含む、1リクエスト分の追加指定 */
export type OrcaExtras = {
  /** data URI または https URL。Vision対応モデルにのみ渡す */
  imageDataUrl?: string;
  /** OpenAI互換の json_schema。返り値がこのschemaに従う */
  jsonSchema?: { name: string; schema: unknown };
  /** タスク既定のmax_tokensを上書きする（画像読解は出力が長い） */
  maxTokens?: number;
  /** タスク既定のタイムアウトを上書きする（Visionは60秒超えることがある） */
  timeoutMs?: number;
  /**
   * 単一tool強制呼び出し（2026-08-13追加）。指定するとOpenAI互換のtool callingで
   * 呼び出し、モデルが返した function.arguments のJSON文字列を text として返す。
   *
   * なぜ response_format ではなく tool にするか（/api/propose で使用）:
   * OrcaRouterの**Agent Firewallはtool呼び出しだけを管轄する**（content=Guardrails /
   * tools=Firewall という公式の区分）。配置提案をtool callにすることで、
   * ゲートウェイ側の args_match_json 検証（実在18ゾーン外へのdeny）が効くようになる
   * ＝ JSON Schema（アプリ側）＋ Firewall（ゲートウェイ側）の二重防御。
   */
  tool?: { name: string; description?: string; parameters: unknown };
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function attempt(
  model: string,
  policy: RoutingPolicy,
  args: { system: string; user: string; extras?: OrcaExtras },
  apiKey: string
): Promise<{ text: string; usage: OrcaUsage | null; resolvedModel: string | null; router: string | null }> {
  const extras = args.extras ?? {};
  const timeout = extras.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // 画像があるときだけ content を配列にする。テキストのみなら従来どおり文字列
  const userContent: string | ContentPart[] = extras.imageDataUrl
    ? [
        { type: "text", text: args.user },
        { type: "image_url", image_url: { url: extras.imageDataUrl } },
      ]
    : args.user;

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
          { role: "user", content: userContent },
        ],
        temperature: policy.temperature,
        max_tokens: extras.maxTokens ?? policy.maxTokens,
        ...(extras.jsonSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: extras.jsonSchema.name, strict: true, schema: extras.jsonSchema.schema },
              },
            }
          : {}),
        ...(extras.tool
          ? {
              tools: [
                {
                  type: "function",
                  function: {
                    name: extras.tool.name,
                    description: extras.tool.description,
                    parameters: extras.tool.parameters,
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: extras.tool.name } },
            }
          : {}),
      }),
    });

    const data = (await res.json()) as ChatCompletion;
    if (!res.ok) {
      throw new OrcaError(
        data?.error?.message || `OrcaRouter request failed (${res.status})`,
        res.status
      );
    }

    // ⚠ 打ち切りを黙って通さない。
    // 推論モデルは thinking でトークンを使い切り、本文が途中で切れたまま HTTP 200 を返す。
    // ここで検出しないと「JSONパース失敗」という遠い場所のエラーとして現れ、原因が追いにくい。
    const finish = data.choices?.[0]?.finish_reason;
    if (finish === "length") {
      throw new OrcaError(
        `${model} の応答が max_tokens で打ち切られました（出力 ${data.usage?.completion_tokens ?? "?"} トークン）。上限を上げてください`,
        502
      );
    }

    // ⚠ Agent Firewallによる遮断も黙って通さない（2026-08-13実測で判明）。
    // response段階のブロックはHTTP 400ではなく、HTTP 200 + finish_reason="content_filter" +
    // content に "[blocked by workspace firewall policy: ...]" という形で返る
    // （inbound段階のHTTP 400ブロックとは別の経路。scripts/firewall-check.mjs参照）。
    // ここで検出しないと「JSONパース失敗」として遠くで現れる。
    if (finish === "content_filter" && /firewall/i.test(data.choices?.[0]?.message?.content ?? "")) {
      throw new OrcaError(
        `${model} の呼び出しはゲートウェイのFirewallに遮断されました: ${data.choices?.[0]?.message?.content}`,
        403
      );
    }

    // tool指定時は function.arguments（JSON文字列）を text として返す。
    // Firewallにdenyされた場合は上のerrorチェック（!res.ok）で OrcaError になる
    const message = data.choices?.[0]?.message;
    const toolArgs = extras.tool ? message?.tool_calls?.[0]?.function?.arguments : undefined;
    if (extras.tool && !toolArgs) {
      throw new OrcaError(
        `${model} がtool呼び出し（${extras.tool.name}）を返しませんでした`,
        502
      );
    }
    return {
      text: toolArgs ?? message?.content ?? "",
      usage: data.usage ?? null,
      // X-Orca-* ヘッダ = どう振り分けられたかの根拠 (docs: /routing/response-headers)
      resolvedModel: res.headers.get("x-orca-resolved-model"),
      router: res.headers.get("x-orca-router"),
    };
  } catch (error) {
    if (error instanceof OrcaError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new OrcaError(`${model} timed out after ${timeout}ms`, 504);
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
  extras?: OrcaExtras;
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
