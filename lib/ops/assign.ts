import { centroid } from "@/lib/forecast/model";
import type { RosterGroup, RosterMember } from "@/lib/data/roster";
import { isAssignedTo, latestDispatchFor, memberBadge } from "./board";
import { ROLE_LABEL, zoneById, type Post, type PostRole } from "./staffing";
import type { Dispatch, Staff } from "./store";

/**
 * 初期配置プラン — 名簿を空きポストへ機械的に割り当てる純関数層。
 *
 * 2026-08-13 新設。イベント開場前は名簿23名が全員未配置になる。指示者が1人ずつ
 * 「選ぶ→ゾーンをタップ→確認→配信」を23回やるのは現実的でないため、
 * **「各メンバーを役割と現在位置に沿って配置する案」を一括で作り、人間が承認して
 * 一斉配信する**フローをここで支える。
 *
 * このモジュールは3役を担う（すべて決定的計算。LLMはここでは一切関与しない）:
 *   1. `buildAssignmentContext` — 「誰が空いているか（候補）」「どのポストが空いているか
 *      （空席）」を当日データ（Staff/Dispatch）から求める
 *   2. `planInitialAssignment` — その集合から「即座に出る案」を貪欲法で決定的に組む。
 *      LLM不達時のフォールバックにもそのまま使い回せる
 *   3. `validateAssignments` — 後段でLLM（`/api/assign`想定）が同じ形の案を作るときの
 *      検証・正規化を担う。**LLMには既存の空きポストから選ばせるだけで、
 *      ポストコードを発番させない**（`A-2` は無線・掲示の語彙で、採番がズレると
 *      着任済みスタッフが孤児化する。`staffing.ts` の受付ポスト採番コメント参照）。
 *      ここが安全装置の本体: 架空の名前・架空のポストコードの発番・二重割り当てを
 *      機械的に弾く（役割不一致は現場で兼任が普通なので棄却しない。warningsで見せるだけ）
 */

export type Assignment = {
  /** ROSTER の id。名簿外なら "" */
  memberId: string;
  name: string;
  role: PostRole;
  /** 現在のポストコード。未配置なら "" */
  fromCode: string;
  toZoneId: string;
  toZoneName: string;
  toPostCode: string;
  /** 決定的に生成する日本語（例「メイン担当・誘導 → C-2（担当ゾーンの空席）」） */
  reason: string;
  source: "calc" | "ai";
};

export type AssignmentContext = {
  /** 配置の対象になるメンバー（ROSTER順） */
  candidates: {
    memberId: string;
    name: string;
    role: PostRole;
    group: RosterGroup;
    fromCode: string;
    fromZoneId: string;
  }[];
  /** 割り当て可能な空きポスト（コードの自然順） */
  vacantPosts: Post[];
};

// ── buildAssignmentContext ──────────────────────────────────────

/**
 * 候補（誰が空いているか）と空席（どのポストが空いているか）を当日データから求める。
 *
 * 候補から除外するのは「現場にいる／もう向かっている」人（onpost・moving）と、
 * 「既に指示が飛んでいる」人（アクティブ指示のstatusがsent・moving）。
 * この2つは独立にチェックする必要がある: staffのstateと指示のstatusは別々の
 * データソースで、片方だけ見ると（例: presence登録が無く指示だけ飛んでいる人を）
 * 見落とし、二重指示を作ってしまう。
 */
export function buildAssignmentContext(
  roster: RosterMember[],
  posts: Post[],
  staffList: Staff[],
  dispatches: Dispatch[],
  now: number
): AssignmentContext {
  const staffByName = new Map(staffList.map((s) => [s.name, s]));

  const candidates: AssignmentContext["candidates"] = [];
  for (const m of roster) {
    const staff = staffByName.get(m.name);
    const latest = latestDispatchFor(m.name, dispatches);
    const badge = memberBadge(staff, latest, now);
    if (badge.status === "onpost" || badge.status === "moving") continue;
    if (latest && (latest.status === "sent" || latest.status === "moving")) continue;

    candidates.push({
      memberId: m.id,
      name: m.name,
      role: m.role,
      group: m.group,
      fromCode: staff?.postCode ?? "",
      fromZoneId: staff?.zoneId ?? "",
    });
  }

  // アクティブ指示（sent/moving）の移動先ポストは「予約済み」＝まだ誰も着任していなくても
  // 空席には数えない（そこへ向かっている人がいる）
  const reservedByDispatch = new Set<string>();
  for (const d of dispatches) {
    if ((d.status === "sent" || d.status === "moving") && d.toPostCode) {
      reservedByDispatch.add(d.toPostCode);
    }
  }

  const vacantPosts = posts
    .filter((p) => !staffList.some((s) => isAssignedTo(s.postCode, p.code)))
    .filter((p) => !reservedByDispatch.has(p.code))
    .slice()
    .sort(comparePostCode);

  return { candidates, vacantPosts };
}

/**
 * ポストコードの自然順比較。「A-2」が「A-10」より前に来る必要がある
 * （文字列比較だと "A-10" < "A-2" になり事故る）。ハイフンより前を接頭辞として比較し、
 * 同じ接頭辞なら数値部を数値として比較する。
 *
 * 2026-08-14 export化（lib/ops/deployment.ts の vacantPostsOf が再利用する。
 * 同じロジックを2箇所に書かない）。
 */
export function comparePostCode(a: Post, b: Post): number {
  const [aPrefix, aNum] = splitPostCode(a.code);
  const [bPrefix, bNum] = splitPostCode(b.code);
  if (aPrefix !== bPrefix) return aPrefix < bPrefix ? -1 : 1;
  return aNum - bNum;
}

function splitPostCode(code: string): [prefix: string, num: number] {
  const i = code.indexOf("-");
  if (i === -1) return [code, 0];
  const num = parseInt(code.slice(i + 1), 10);
  return [code.slice(0, i), Number.isNaN(num) ? 0 : num];
}

// ── planInitialAssignment ────────────────────────────────────────

/**
 * 班（RosterGroup）→担当ゾーンの対応表。パス1で使う。
 *
 * `postsFor()`（staffing.ts）はフード・サブゾーンにポストを作らない（誘導ポストは
 * main / exit / wg / eg にしか出ない）。したがってフード班・サブ班は**この対応表を
 * 引いても**パス1では絶対に埋まらず、必ずパス2（現在位置優先）で拾われる。
 * これはバグではなく正常な挙動（HANDOFF/CLAUDE.md参照）。
 */
const ZONE_PREFERENCE_BY_GROUP: Record<RosterGroup, string[]> = {
  メイン: ["main"],
  フード: ["food"],
  サブ: ["sub"],
  給水: ["shop", "wc"],
  救護: ["aid"],
  受付: ["wg", "eg"],
  遊軍: [],
};

/**
 * 貪欲2パスで初期配置案を組む。同じ入力なら必ず同じ出力（決定的）。
 *
 * - パス1（担当ゾーン優先）: 役割一致 かつ 担当ゾーン内の空席へ
 * - パス2（現在位置優先）: パス1で埋まらなかった候補を、役割一致の空席へ。
 *   現在地があれば最も近い空席、なければ空席の自然順で先頭
 *
 * 役割が一致しない割り当ては絶対に作らない（安全側）。埋まらなかった候補は
 * `unassigned`、余った空席は `leftoverPosts` に入れて返す（黙って落とさない）。
 * 1人1ポスト・1ポスト1人を postTaken / assignedMemberIds で保証する。
 */
export function planInitialAssignment(ctx: AssignmentContext): {
  assignments: Assignment[];
  unassigned: AssignmentContext["candidates"];
  leftoverPosts: Post[];
} {
  const assignments: Assignment[] = [];
  const posts = ctx.vacantPosts; // 並び順はbuildAssignmentContextが保証する自然順のまま使う
  const postTaken = new Array(posts.length).fill(false);
  const assignedMemberIds = new Set<string>();

  const takeAndRecord = (
    c: AssignmentContext["candidates"][number],
    idx: number,
    reason: string
  ): void => {
    postTaken[idx] = true;
    assignedMemberIds.add(c.memberId);
    const post = posts[idx];
    assignments.push({
      memberId: c.memberId,
      name: c.name,
      role: c.role,
      fromCode: c.fromCode,
      toZoneId: post.zoneId,
      toZoneName: post.zoneName,
      toPostCode: post.code,
      reason,
      source: "calc",
    });
  };

  // パス1: 担当ゾーン優先
  for (const c of ctx.candidates) {
    const preferredZones = ZONE_PREFERENCE_BY_GROUP[c.group] ?? [];
    if (preferredZones.length === 0) continue;
    const idx = posts.findIndex(
      (p, i) => !postTaken[i] && p.role === c.role && preferredZones.includes(p.zoneId)
    );
    if (idx === -1) continue;
    takeAndRecord(c, idx, `${c.group}担当・${ROLE_LABEL[c.role]} → ${posts[idx].code}（担当ゾーンの空席）`);
  }

  // パス2: 現在位置優先（パス1で埋まらなかった候補のみ、ROSTER順のまま）
  for (const c of ctx.candidates) {
    if (assignedMemberIds.has(c.memberId)) continue;

    const availableIdx: number[] = [];
    for (let i = 0; i < posts.length; i++) {
      if (!postTaken[i] && posts[i].role === c.role) availableIdx.push(i);
    }
    if (availableIdx.length === 0) continue;

    const zone = c.fromZoneId ? zoneById(c.fromZoneId) : undefined;
    if (zone) {
      const from = centroid(zone.shape);
      let bestIdx = availableIdx[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const i of availableIdx) {
        const d = Math.hypot(from.x - posts[i].at.x, from.y - posts[i].at.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      takeAndRecord(c, bestIdx, `${ROLE_LABEL[c.role]} → ${posts[bestIdx].code}（現在地から最も近い空席）`);
    } else {
      const idx = availableIdx[0];
      takeAndRecord(c, idx, `${ROLE_LABEL[c.role]} → ${posts[idx].code}（役割が一致する空席）`);
    }
  }

  const unassigned = ctx.candidates.filter((c) => !assignedMemberIds.has(c.memberId));
  const leftoverPosts = posts.filter((_, i) => !postTaken[i]);

  return { assignments, unassigned, leftoverPosts };
}

// ── validateAssignments ──────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}

/**
 * LLM（後段の `/api/assign` 想定）が返す未検証の値を防御的に検証・正規化する。
 *
 * これがLLM出力に対する安全装置の本体。以下を全て弾く（弾いた数を `rejected` に集計）:
 *   1. 配列でない / 要素がオブジェクトでない
 *   2. `staffName` が `ctx.candidates` に存在しない（架空の名前・表記ゆれ）
 *   3. `toPostCode` が `ctx.vacantPosts` に存在しない
 *      （**架空のポストコードの発番を阻止する。ここが最重要**）
 *   4. 同じ `staffName` が2回出てくる（後勝ちにせず、2件目以降を棄却）
 *   5. 同じ `toPostCode` が2回出てくる（2件目以降を棄却）
 *
 * 通過したものは `Assignment` に正規化する。`toZoneId` / `toZoneName` / `fromCode` / `role`
 * は **LLMの申告ではなく `ctx` から引く**（LLMに自己申告させない。raw側に同名フィールドが
 * あっても無視する）。`reason` だけはLLMの文字列を120字で切って使う（無ければ空文字）。
 *
 * 役割不一致（`member.role !== post.role`）は棄却しない。現場では兼任が普通
 * （`STAFFING_REFERENCE` の「混み具合を見て兼任あり」）。代わりに `warnings` に日本語で積む。
 */
export function validateAssignments(
  raw: unknown,
  ctx: AssignmentContext
): { assignments: Assignment[]; rejected: number; warnings: string[] } {
  const assignments: Assignment[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(raw)) {
    return { assignments, rejected: 0, warnings };
  }

  let rejected = 0;
  const seenNames = new Set<string>();
  const seenCodes = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) {
      rejected++;
      continue;
    }

    const staffName = readString(item, "staffName");
    const candidate = ctx.candidates.find((c) => c.name === staffName);
    if (!candidate) {
      rejected++;
      continue;
    }

    const toPostCode = readString(item, "toPostCode");
    const post = ctx.vacantPosts.find((p) => p.code === toPostCode);
    if (!post) {
      rejected++;
      continue;
    }

    if (seenNames.has(staffName)) {
      rejected++;
      continue;
    }
    if (seenCodes.has(toPostCode)) {
      rejected++;
      continue;
    }
    seenNames.add(staffName);
    seenCodes.add(toPostCode);

    if (candidate.role !== post.role) {
      warnings.push(
        `${candidate.name}（${ROLE_LABEL[candidate.role]}）を${ROLE_LABEL[post.role]}ポスト ${post.code} に割り当てています`
      );
    }

    assignments.push({
      memberId: candidate.memberId,
      name: candidate.name,
      role: candidate.role,
      fromCode: candidate.fromCode,
      toZoneId: post.zoneId,
      toZoneName: post.zoneName,
      toPostCode: post.code,
      reason: readString(item, "reason").slice(0, 120),
      source: "ai",
    });
  }

  return { assignments, rejected, warnings };
}
