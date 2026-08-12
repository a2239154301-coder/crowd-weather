import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * tsconfig の `@/*` エイリアスを Vitest にも通す。
 * 2026-08-13 追加（lib/data・lib/ops など層をまたぐ新モジュールが `@/` を使うため。
 * 従来のテストは相対importのみで、設定なしで動いていた）。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
