"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * リスト行 → 会場図へのドラッグ&ドロップ（配置ボード 2026-08-13 追加）。
 *
 * ## 設計判断1: ドラッグは「操作糖衣」であって新しい配信経路ではない
 *
 * `onDrop` は配置ボードの既存ハンドラ（メンバー選択 → ゾーンタップ）と同じものを呼ぶだけで、
 * 最終的に開くのは**同じ確認モーダル**。CLAUDE.md の「配信の入口は承認UIだけ／AIが直接実行する
 * 経路は作らない」を壊さないため、**ドラッグで直接 /api/dispatch を叩くことはしない**。
 * 既存の「タップ2回」も残す（タッチでの誤爆時の逃げ道であり、モバイル対応の本線でもある）。
 *
 * ## 設計判断2: タッチのスクロールを壊さないための方式
 *
 * リストはモバイルで `max-height: 40vh` の縦スクロール領域。行の上で pointerdown した瞬間に
 * ドラッグを始めると、スクロールしたいだけの指を掴んでしまう。
 *
 * `touch-action: none` を後から付けても効かない — ブラウザは touchstart の時点でヒットテストして
 * スクロールを開始するので、ジェスチャ途中の touch-action 変更を尊重しない。確実なのは
 * **非passive な touchmove で preventDefault** の一択なので、そちらを採る。
 * `armed` が false の間は preventDefault しない ＝ **リストの縦スクロールは従来どおり**動く。
 *
 * - マウス/ペン: `DRAG_THRESHOLD_PX` 動いたら開始（それ未満の pointerup は従来のタップ選択のまま）
 * - タッチ: 長押し `LONG_PRESS_MS`。その間に動いたら「スクロール意図」としてキャンセルし、二度と armed にしない
 *
 * ## 設計判断3: setPointerCapture ではなく window リスナー
 *
 * 「カーソルが行の外へ出ると pointermove が途切れる」問題は、ふつう `setPointerCapture` で解くが、
 * ここでは **pointermove/up/cancel を window に張る**ことで解いている。ドラッグ先は行の外（会場図）に
 * あるのが常なので、捕捉の有無に依存しない形のほうが壊れにくい。
 * （React の再レンダーで行のDOMが差し替わっても捕捉が外れない、という副次的な利点もある）
 *
 * ## 設計判断4: 追従チップの位置は state に載せない
 *
 * pointermove ごとに state を更新すると、23行のリストとSVG会場図が毎フレーム再レンダーされる。
 * 位置は `chipRef` の `transform` へ直接書き込み、state は「誰を掴んでいるか」「どのゾーンの上か」
 * だけに絞る（どちらも滅多に変わらない）。
 */

/** マウス/ペンでドラッグと判定する移動量。これ未満で離したら従来どおりのタップ選択 */
const DRAG_THRESHOLD_PX = 8;
/** タッチで長押しと判定する時間 */
const LONG_PRESS_MS = 300;
/** タッチの長押し待機中にこれ以上動いたら「スクロールしたいだけ」と判断して降りる */
const SCROLL_INTENT_PX = 8;

export type DropTarget = { zoneId: string; postCode?: string };

type Options = {
  /** ドロップ確定。配置ボードでは「選択 → ゾーンタップ」と同じ経路（＝確認モーダルを開く）へ繋ぐ */
  onDrop: (name: string, target: DropTarget) => void;
  /** true の間はドラッグを開始しない（モーダルが開いている間など） */
  disabled?: boolean;
};

type PressState = {
  name: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  /** タッチの長押しタイマー。マウスでは null */
  timer: ReturnType<typeof setTimeout> | null;
  /** 長押し待機中に動いてしまった＝スクロール意図。以後 armed にしない */
  abandoned: boolean;
};

export function useDragToMap({ onDrop, disabled = false }: Options) {
  /** 掴んでいるメンバー名。null=ドラッグしていない */
  const [draggingName, setDraggingName] = useState<string | null>(null);
  /** いまポインタが乗っているゾーン（会場図のハイライト用） */
  const [overZoneId, setOverZoneId] = useState<string | null>(null);

  /** 追従チップ。consumer が `position: fixed; pointer-events: none` の要素に付ける */
  const chipRef = useRef<HTMLDivElement | null>(null);

  const pressRef = useRef<PressState | null>(null);
  /** true の間だけ document の touchmove を preventDefault する（＝スクロールを止める） */
  const armedRef = useRef(false);
  /** ドラッグ直後の click 抑止を解除する関数（張っていなければ null） */
  const swallowCleanupRef = useRef<(() => void) | null>(null);
  /** 最新のポインタ座標。チップの transform 反映に使う */
  const posRef = useRef({ x: 0, y: 0 });
  /** onDrop の最新参照（window リスナーを張り直さないため） */
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  /**
   * ドラッグ終了直後の click を1回だけ潰す。
   *
   * 行に `onClickCapture` を置く方式では駄目だった: マウスでドラッグして会場図の上で離すと、
   * ブラウザは pointerdown と pointerup の**最も近い共通の祖先**に click を出す（＝行ではない）。
   * 行のハンドラは呼ばれないので抑止フラグが立ちっぱなしになり、**次に行を普通にタップした
   * その1回が食われる**（「タップしたのに何も起きない」に見える）。タッチでは preventDefault の
   * 結果そもそも click が出ないので、やはりフラグが残る。
   * そこで window の capture 相で1回だけ待ち構え、100ms 以内に来なければ諦めて解除する。
   */
  const swallowNextClick = useCallback(() => {
    swallowCleanupRef.current?.();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      window.removeEventListener("click", onClick, true);
      if (timer) clearTimeout(timer);
      swallowCleanupRef.current = null;
    };
    const onClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      cleanup();
    };
    timer = setTimeout(cleanup, 100);
    window.addEventListener("click", onClick, true);
    swallowCleanupRef.current = cleanup;
  }, []);

  const paintChip = useCallback(() => {
    const el = chipRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
  }, []);

  // チップがマウントされた直後に一度描く（マウント前の pointermove では ref が null のため）
  useEffect(() => {
    if (draggingName) paintChip();
  }, [draggingName, paintChip]);

  /**
   * スクロールの抑止。`armed` が false のときは何もしない＝従来どおりスクロールできる。
   * React の onTouchMove は passive になり得るので、**必ず native + { passive: false }** で張る。
   */
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (armedRef.current) e.preventDefault();
    };
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, []);

  const endPress = useCallback(() => {
    const p = pressRef.current;
    if (p?.timer) clearTimeout(p.timer);
    pressRef.current = null;
    armedRef.current = false;
    setDraggingName(null);
    setOverZoneId(null);
  }, []);

  /** ポインタ位置から会場図のゾーン／空席ポストを引く。SVG座標の逆変換はせずブラウザのヒットテストに任せる */
  const hitTest = useCallback((x: number, y: number): DropTarget | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    // 空席ポストの上に落ちたときはポストまで確定させる（ゾーンだけなら最初の空きポストに任せる）
    const postEl = el.closest("[data-post-code]");
    const zoneEl = el.closest("[data-zone-id]");
    const zoneId = zoneEl?.getAttribute("data-zone-id");
    if (!zoneId) return null;
    const postCode = postEl?.getAttribute("data-post-code") ?? undefined;
    return postCode ? { zoneId, postCode } : { zoneId };
  }, []);

  const arm = useCallback(
    (name: string, x: number, y: number) => {
      armedRef.current = true;
      posRef.current = { x, y };
      setDraggingName(name);
      paintChip();
    },
    [paintChip]
  );

  // ── window レベルの move / up / cancel ──
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = pressRef.current;
      if (!p || e.pointerId !== p.pointerId) return;

      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      const dist = Math.hypot(dx, dy);

      if (!armedRef.current) {
        if (p.pointerType === "touch") {
          // 長押し成立前に動いた＝スクロールしたいだけ。掴まずに降りる（誤爆の主因をここで潰す）
          if (dist > SCROLL_INTENT_PX && !p.abandoned) {
            p.abandoned = true;
            if (p.timer) clearTimeout(p.timer);
            p.timer = null;
          }
          return;
        }
        // マウス/ペンは閾値を超えた時点で開始
        if (dist > DRAG_THRESHOLD_PX) arm(p.name, e.clientX, e.clientY);
        else return;
      }

      posRef.current = { x: e.clientX, y: e.clientY };
      paintChip();
      const hit = hitTest(e.clientX, e.clientY);
      setOverZoneId((prev) => (prev === (hit?.zoneId ?? null) ? prev : (hit?.zoneId ?? null)));
    };

    const onUp = (e: PointerEvent) => {
      const p = pressRef.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const wasDragging = armedRef.current;
      const name = p.name;
      if (wasDragging) {
        const hit = hitTest(e.clientX, e.clientY);
        // ドラッグ後の click は行のタップ選択と二重に走るので1回だけ握りつぶす
        swallowNextClick();
        endPress();
        if (hit) onDropRef.current(name, hit);
        return;
      }
      endPress();
    };

    const onCancel = (e: PointerEvent) => {
      const p = pressRef.current;
      if (!p || e.pointerId !== p.pointerId) return;
      // ブラウザがスクロールを開始した等。掴んでいたなら click 抑止だけ残して畳む
      if (armedRef.current) swallowNextClick();
      endPress();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [arm, endPress, hitTest, paintChip, swallowNextClick]);

  // アンマウント時にタイマーとスクロール抑止を必ず解除する
  useEffect(() => {
    return () => {
      const p = pressRef.current;
      if (p?.timer) clearTimeout(p.timer);
      armedRef.current = false;
      swallowCleanupRef.current?.();
    };
  }, []);

  const rowHandlers = useCallback(
    (name: string) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        if (disabled) return;
        // 主ボタン以外（右クリック・中クリック）は無視
        if (e.pointerType === "mouse" && e.button !== 0) return;
        if (pressRef.current) return;

        const press: PressState = {
          name,
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          startX: e.clientX,
          startY: e.clientY,
          timer: null,
          abandoned: false,
        };
        pressRef.current = press;

        if (e.pointerType === "touch") {
          const { clientX, clientY } = e;
          press.timer = setTimeout(() => {
            const cur = pressRef.current;
            if (!cur || cur !== press || cur.abandoned) return;
            cur.timer = null;
            arm(name, clientX, clientY);
          }, LONG_PRESS_MS);
        }
      },
      /**
       * 長押し中に iOS/Android が出すテキスト選択カルーセルとコンテキストメニューを止める。
       * これを止めないと 300ms より先にOS側のUIが出てドラッグにならない。
       */
      onContextMenu: (e: ReactMouseEvent) => {
        if (pressRef.current || armedRef.current) e.preventDefault();
      },
      style: {
        // 縦スクロールはブラウザに任せたまま（止めるのは armed のときの touchmove だけ）
        touchAction: "pan-y" as const,
        userSelect: "none" as const,
        WebkitUserSelect: "none" as const,
        WebkitTouchCallout: "none" as const,
      },
    }),
    [arm, disabled]
  );

  return {
    /** 掴んでいるメンバー名。null=ドラッグしていない */
    draggingName,
    /**
     * いまポインタが乗っているゾーンID（会場図のハイライト用）。
     * ポストコードまで確定したかは `onDrop` の `target.postCode` で受け取る
     * （state に載せると1フレームごとに再レンダーが増えるだけで、描画には使わないため返さない）
     */
    overZoneId,
    /** 追従チップに付ける ref。`position: fixed; left:0; top:0; pointer-events:none` にすること */
    chipRef,
    /** リスト行に展開するハンドラ群 */
    rowHandlers,
  };
}
