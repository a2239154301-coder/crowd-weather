"use client";

import { useEffect, useRef, useState } from "react";

/**
 * ポーリングの成否を画面に出すための小さなフック（2026-08-13 新設）。
 *
 * 従来はポーリング失敗を `catch {}` で握りつぶしていた（39箇所）。現場のスマホは
 * 電波が悪い前提なのに、通信が切れていることが画面に一切出ない状態だった
 * （馬場氏レビューP1「失敗・遅延を通常状態と同じ見た目にしない」）。
 *
 * 使い方: `const sync = useSyncStatus()` を作り、各tick関数の成功時に
 * `sync.ok()`、失敗時に `sync.fail()` を呼ぶ。`sync.label` をどこかに出す。
 * 通信のやり方（fetch先・間隔）は変えない。表示を1つ足すだけ。
 */
export type SyncStatus = {
  /** "接続中" | "更新: n秒前" | "接続が切れています（最終更新 n秒前）" */
  label: string;
  ok: boolean;
  markOk: () => void;
  markFail: () => void;
};

export function useSyncStatus(): SyncStatus {
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [failing, setFailing] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const markOk = useRefCallback(() => {
    setLastOk(Date.now());
    setFailing(false);
  });
  const markFail = useRefCallback(() => {
    setFailing(true);
  });

  const secsAgo = lastOk === null ? null : Math.max(0, Math.round((Date.now() - lastOk) / 1000));

  let label: string;
  if (lastOk === null) label = failing ? "接続できません" : "接続中…";
  else if (failing) label = `接続が切れています（最終更新 ${secsAgo}秒前）`;
  else label = secsAgo === 0 ? "更新: いま" : `更新: ${secsAgo}秒前`;

  return { label, ok: !failing, markOk, markFail };
}

// setInterval のコールバックを毎レンダー作り直さないための最小ヘルパー
function useRefCallback(fn: () => void): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useRef(() => ref.current()).current;
}
