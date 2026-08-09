# CROWD WEATHER

**混雑は、予報できる。**

イベント会場の**混雑**と**暑熱**を時間帯別に予報し、雑踏警備計画書と人員配置をそのまま出力するプラットフォーム。

- AI HACK 2026 提出プロダクト
- LLMゲートウェイに **[OrcaRouter](https://orcarouter.ai)** を使用

---

## セットアップ

```bash
npm install
cp .env.example .env.local     # コピーしてから実キーに書き換える
npm run dev                    # http://localhost:3000
```

`.env.local` に OrcaRouter のAPIキーを設定します。

```
ORCAROUTER_API_KEY=sk-orca-...
```

キーは [orcarouter.ai](https://www.orcarouter.ai) のダッシュボードで発行します。
**`.env*` は `.gitignore` 済みです。実キーをコミット・共有しないでください。**

## 構成

```
app/
  page.tsx              画面のエントリ
  api/advice/route.ts   予報値 → 運営判断の言語化
  api/models/route.ts   利用可能モデルの実在確認（開発用）
components/
  crowd-weather.tsx     予報モデル + 主催者コンソール + 来場者アプリ
lib/ai/
  orca.ts               OrcaRouter を呼ぶ唯一の口（ルーティング方針・フォールバック・usage回収）
  prompts.ts            プロンプト定義
scripts/
  bench.mjs             モデル実測ベンチ（node scripts/bench.mjs）
```

## LLMをどこで使い、どこで使わないか

審査項目⑥（LLMコスト）に対する設計方針。**主処理はLLMに投げない。**

| 処理 | LLM | 理由 |
|---|---|---|
| 時間帯別の混雑指数・WBGT推定 | ❌ | 決定的な計算で足りる |
| 3D都市モデルによる日陰計算 | ❌ | 同上 |
| 人員配置の最適化 | ❌ | 同上 |
| 地図描画・時間スクラバー・可視化 | ❌ | 同上 |
| **数値 → 運営判断の言語化** | ✅ | 人間が読んで判断し、承認プロセスに乗せる文書を作る仕事 |

LLMを呼ぶのは `app/api/orca/route.ts` の1箇所だけ。使用モデル・トークン数はレスポンスに含めて
画面に表示するため、**実測原価をそのまま提示できる**。

## OrcaRouter の使い方

`base_url` を差し替えるだけのOpenAI互換API。呼び出しは `lib/ai/orca.ts` の1箇所に集約し、
**タスクごとに適材適所でモデルを切り替えて**いる。

| task | 用途 | 第一候補 | 実測 |
|---|---|---|---|
| `advice` | 予報値 → 運営判断 | `google/gemini-2.5-flash-lite` | 2.48秒 |
| `ingest` | 会場資料の読解（実装予定） | `google/gemini-2.5-pro` | — |
| `plan` | 計画書の起草（実装予定） | `anthropic/claude-sonnet-4.6` | 18.73秒 |

### なぜ `orcarouter/auto` を使わないのか

`auto` の既定戦略は cheapest。同じプロンプトでの実測（`scripts/bench.mjs`）:

| | 秒 | 出力トークン |
|---|---|---|
| `orcarouter/auto` → `qwen/qwen3.7-plus` に解決 | **45.96** | **2,620** |
| `google/gemini-2.5-flash-lite` | **2.48** | **342** |

最安モデルが推論モデルだと、トークン単価は安くても総トークンと待ち時間が跳ねる。
**トークン単価が最安 ≠ 1リクエストの総コストが最安**、というのが実測の結論。
ベンダーのルーティングを鵜呑みにせず、計測して明示ルーティングを選んだ。

### フォールバック

第一候補が 5xx / 429 / タイムアウトで落ちたら次の候補へ切り替える。
**アプリ側（`lib/ai/orca.ts`）で実装している** — OrcaRouter の `models` + `route:"fallback"` は
生HTTPで検証したかぎり鎖を付けない場合と挙動が変わらず、効いている証拠を取れなかったため。
第一候補を存在しないモデルに差し替えて、200 で `fallbackLevel: 1` になることを確認済み。

### ルーティングを隠さない

応答した実モデル・入出力トークン数・レイテンシを画面に表示している。
審査項目⑥（LLMコスト）の実測原価は、この値をそのまま積算して出す。
