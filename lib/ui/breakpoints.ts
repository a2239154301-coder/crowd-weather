/**
 * 画面幅のブレークポイント（2026-08-14 新設）。
 *
 * 従来は 900px（`app-shell.tsx` の `.cw-split`/`.cw-plan`/`.cw-steps`・`heatmap-console.tsx` の `.hm-split`）と
 * 760px（`staff-board.tsx` の `.cw-board`）と 840px（`crowd-weather.tsx` の `.cw-grid`）が混在していた。
 * 760〜900px の帯では「上位タブは1列に畳まれているのに配置ボードだけ2列のまま」という
 * 噛み合わない状態が起きるため、**900px に統一**する。
 *
 * このプロジェクトは Tailwind を使わず全インラインstyleなので、メディアクエリだけは
 * 各コンポーネント内の `<style>` タグで書く。その文字列にこの定数を差し込む。
 *
 * ⚠ `components/original/mock.tsx` の 840px は legacy `/original` ページ（馬場氏の原案モックの保存）
 * 専用なので**触らない**。あちらは現行UIと同じ規則に揃える対象ではない。
 */
export const BP_SPLIT = 900;

/** `@media (max-width: 900px)` の文字列。テンプレートリテラルに差し込んで使う */
export const MQ_SPLIT = `@media (max-width: ${BP_SPLIT}px)`;
