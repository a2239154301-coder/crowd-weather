# CROWD WEATHER

**混雑は、予報できる。**

イベント会場の**混雑**と**暑熱**を時間帯別に予報し、雑踏警備計画書と人員配置をそのまま出力するプラットフォーム。

- **AI HACK 2026** 提出プロダクト
- LLMゲートウェイに **[OrcaRouter](https://orcarouter.ai)** を使用

---

## デモを見る

公開デモはOrcaRouterのクレジット枯渇を防ぐため、簡易な合言葉ゲートの内側にあります。

**合言葉: `crowdweather2026`**

初回アクセス時に `/gate` へ誘導されるので、上記を入力してください。

## APIキーなしで確認できること

審査・レビューでリポジトリを手元で動かす場合、**キーがなくても以下は動きます**。

```bash
npm install
npm test          # 20ファイル・331件（すべてキー不要）
npm run build     # 型チェック込み
npm run dev       # 予報エンジン・会場図・時間スクラバー・計画書の画面はキーなしで動く
```

混雑指数・WBGT・日陰計算・リスク予報・経路探索は**すべてLLMを使わない決定的計算**なので、
キーがなくても製品の中核は動きます。

**キーが必要なのはAI機能だけ**です（計画書の起草・現場指示の生成・会場写真の読解・配置提案）。
試す場合は自分のキーを設定してください。

```bash
cp .env.example .env.local     # コピーしてから実キーに書き換える
```

```
ORCAROUTER_API_KEY=sk-orca-...
```

キーは [orcarouter.ai](https://www.orcarouter.ai) のダッシュボードで発行します。
**`.env*` は `.gitignore` 済みです。実キーをコミット・共有しないでください。**

## 読む順番（審査・レビュー向け）

| 見たいもの | 場所 |
|---|---|
| 実測値の一覧（原価・ベンチ・検証結果） | **[`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md)** |
| OrcaRouterのダッシュボード設定（コードから見えない部分） | **[`docs/ORCAROUTER-SETUP.md`](docs/ORCAROUTER-SETUP.md)** |
| 技術構成と設計判断の経緯 | [`docs/ARCHITECTURE.ja.md`](docs/ARCHITECTURE.ja.md) / [`TECH_STACK.md`](TECH_STACK.md) |
| 数値の出典 | [`docs/DATA-SOURCES.ja.md`](docs/DATA-SOURCES.ja.md) |
| LLMを呼ぶ唯一の口 | [`lib/ai/orca.ts`](lib/ai/orca.ts) |
| LLMを使わない計算層 | [`lib/forecast/`](lib/forecast/) |

## 構成

```
app/
  api/            APIルート18本（advice / plan / ingest / assign / propose / dispatch ほか）
  internal/       Next.js版のUI（開発・検証用）
  gate/           合言葉ゲートの入力画面
components/       画面（会場図・予報コンソール・当日モード・来場者・審査向け）
lib/
  forecast/       ★ 予測層 — LLMを一切使わない決定的計算
  ai/             ★ 判断層 — ここだけがLLMを使う（orca.ts が唯一の口）
  ops/            スタッフ配置・ポストコード体系・配置計画の永続化
middleware.ts     合言葉ゲート＋ルート「/」の振り分け
scripts/          実測用スクリプト（bench / router-check / firewall-check / verify-wbgt ほか）
public/CROWD_WEATHER_v5.html   提出用フロントエンド（ルート「/」で配信）
```

**要点は `lib/forecast/` と `lib/ai/` がフォルダで分かれていること**です。
「どこでAIを使い、どこで使っていないか」がディレクトリを見ただけで分かります。

## LLMをどこで使い、どこで使わないか

審査項目⑥（LLMコスト）に対する設計方針。**主処理はLLMに投げない。**

| 処理 | LLM | 理由 |
|---|---|---|
| 混雑指数・WBGT・日陰計算 | ❌ | 入力が決まれば答えが1つに決まる。安全に関わる数字がブレてはいけない |
| リスク予報・危険の到来順 | ❌ | 同上 |
| 経路探索（ダイクストラ法） | ❌ | 安全案内で毎回違う答えが返ってはいけない。数msで終わる処理 |
| 人員配置のポストコード発番 | ❌ | 採番がズレると着任済みスタッフが現場で行方不明になる |
| 地図描画・時間スクラバー | ❌ | 決定的な計算で足りる |
| **会場資料（写真・図面）の読解** | ✅ | 会場ごとに様式がバラバラ。ルールベースでは会場ごとに作り直しになる |
| **数値 → 運営判断の言語化** | ✅ | 人間が読んで承認する文書を作る仕事 |
| **配置案の起草** | ✅ | ただし実行可能性はサーバー側の検証層が保証する |

判断の軸は1本です。**人間の承認を経ずに数値・指示として使われるものは決定的計算**、
**人間が読んで承認する案と文章はLLM可**。そして**配信を起こせるのは人間の明示操作だけ**で、
AIが配信APIを直接叩ける経路は作っていません。

## OrcaRouter の使い方

`base_url` を差し替えるだけのOpenAI互換API。呼び出しは `lib/ai/orca.ts` の1箇所に集約し、
**タスクごとに適材適所でモデルを切り替えて**います。

| task | 用途 | 第一候補 | 実測 |
|---|---|---|---|
| `advice` | 予報値 → 運営判断・現場指示 | `orcarouter/cw-advice`（名前付きルーター） | 1.1〜1.7秒 |
| `ingest` | 会場資料の読解（Vision） | `openai/gpt-4.1` | 9.5〜11.3秒 |
| `plan` | 計画書の起草 | `anthropic/claude-sonnet-4.6` | 18.73秒 |
| `whatif` | 自由文 → シナリオ差分の翻訳 | `openai/gpt-4.1` | — |

名前付きルーターの中身（許可モデル・戦略）とGuardrails・Firewallの設定は
**[`docs/ORCAROUTER-SETUP.md`](docs/ORCAROUTER-SETUP.md)** に書き出しています
（ダッシュボード側の設定はコードからは見えないため）。

### なぜ `orcarouter/auto` を使わないのか

`auto` の既定戦略は cheapest。同じプロンプトでの実測（`scripts/bench.mjs`）:

| | 秒 | 出力トークン |
|---|---|---|
| `orcarouter/auto` → `qwen/qwen3.7-plus` に解決 | **45.96** | **2,620** |
| `google/gemini-2.5-flash-lite` | **2.48** | **342** |

最安モデルが推論モデルだと、トークン単価は安くても総トークンと待ち時間が跳ねる。
**トークン単価が最安 ≠ 1リクエストの総コストが最安**、というのが実測の結論です。
ベンダーのルーティングを鵜呑みにせず、計測して明示ルーティングを選びました。

### フォールバック

第一候補が 5xx / 429 / タイムアウトで落ちたら次の候補へ切り替えます。
**アプリ側（`lib/ai/orca.ts`）で実装** — OrcaRouter の `models` + `route:"fallback"` は
生HTTPで検証したかぎり鎖を付けない場合と挙動が変わらず、効いている証拠を取れなかったためです。
第一候補を存在しないモデルに差し替え、200で `fallbackLevel: 1`・2.71秒で切り替わることを確認済み。

### ルーティングを隠さない

応答した実モデル・入出力トークン数・レイテンシ・概算円を**画面にそのまま表示**しています。
審査項目⑥の実測原価は、この値を積算したものです（内訳は
[`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) §1）。

## セキュリティ

| 層 | 内容 |
|---|---|
| APIキーの隔離 | `lib/ai/orca.ts` の1ファイルに集約。ブラウザからAIを直接叩ける経路は作らない |
| アクセス制御 | 合言葉ゲート（`middleware.ts`・HttpOnly Cookie・定数時間比較）。**デモ期間の保護であって本番認証ではない** |
| 入力の保護 | OrcaRouter Guardrails / PII Shield。**標準検出器が日本の携帯番号を素通しする穴を実測で発見**しカスタム正規表現で対応 |
| AI出力の検証 | サーバー側で実在確認。配置案19件中2件を棄却（実測） |
| Agent Firewall | 遮断は実測済み。**本番は監視モード（audit-only）で運用中** |

扱う題材が「警備が手薄な時間と場所」を示す文書であるため、**デモの会場は架空**です
（実在会場の実配置を公開物に出さない）。

詳細は [`docs/ORCAROUTER-SETUP.md`](docs/ORCAROUTER-SETUP.md) と
[`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) を参照してください。
