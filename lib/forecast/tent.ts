/**
 * テント配置提案。
 *
 * 出典: 馬場氏 v4 原本 components/original-v4/mock.jsx の
 * 「7. テント配置提案」セクション（189〜208行付近）を忠実移植。
 * 判定条件（WBGT>=28 かつ 日陰率<0.6）・必要数の式・from/to の出し方は無改変。
 *
 * 原本はモジュール内のグローバル配列 SZONES に依存する関数だったが、
 * ここでは steps と zones を引数として受け取るだけのグローバル非依存の
 * 純関数にしている（ロジック自体は変えていない）。
 */

export type TentZoneInput = { id: string; name: string; queueArea: number };

export type TentStep = {
  minutes: number;
  night: boolean;
  zones: { id: string; shade: number; wbgt: number }[];
};

export type TentAdvice = {
  zone: TentZoneInput;
  need: number;
  at: number;
  shade: number;
  wbgt: number;
  from: number;
  to: number;
};

/** テント1張りがカバーする面積（m^2）。3m×6m。原本: const TENT = 18 */
export const TENT = 18;

/** 原本: function tentPlan(steps) （SZONES はここでは引数 zones として渡す） */
export function tentPlan(
  steps: TentStep[],
  zones: TentZoneInput[]
): { list: TentAdvice[]; total: number } {
  const perZone: Record<string, TentAdvice> = {};
  for (const z of zones) {
    if (!z.queueArea) continue;
    let worst: { need: number; at: number; shade: number; wbgt: number } | null = null;
    const hours: number[] = [];
    for (const st of steps) {
      if (st.night) continue;
      // 原本と同じく、対応ゾーンが見つからない場合のガードは入れていない
      // （見つからなければ原本同様に例外になる＝入力の不整合を早期に検出する）
      const zs = st.zones.find((q) => q.id === z.id)!;
      if (zs.wbgt >= 28 && zs.shade < 0.6) {
        hours.push(st.minutes);
        const need = Math.ceil((z.queueArea * (1 - zs.shade)) / TENT);
        if (!worst || need > worst.need) {
          worst = { need, at: st.minutes, shade: zs.shade, wbgt: zs.wbgt };
        }
      }
    }
    if (worst) {
      perZone[z.id] = {
        zone: z,
        ...worst,
        from: Math.min(...hours),
        to: Math.max(...hours) + 30,
      };
    }
  }
  const list = Object.values(perZone).sort((a, b) => b.need - a.need);
  return { list, total: list.reduce((s, x) => s + x.need, 0) };
}
