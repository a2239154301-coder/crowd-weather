import type { Metadata } from "next";
import { rosterById } from "@/lib/data/roster";
import { DAY } from "@/lib/ui/day-theme";
import { ScenarioProvider } from "@/lib/ui/scenario-context";
import StaffConsole from "@/components/staff-console";

/**
 * スタッフ個別の固定ページ（/staff/[id]）。
 *
 * 2026-08-13 新設。配布URLを名簿の各スタッフに1本ずつ渡す運用のためのページ
 * （app-shell内の通常スタッフタブは「誰でも入場フォームから入る」汎用画面だが、
 * こちらは「このURLを開いた人＝このスタッフ」を前提に、入場フォームを出さず
 * 固定の名前でpresence登録する — components/staff-console.tsx の fixedMember 参照）。
 *
 * globals.css の body は暗色（計画モード基調）固定のため、当日系画面と同じく
 * ここだけ明色ラッパで包む（app/original/page.tsx の流儀を踏襲）。
 *
 * Next.js 16: params は Promise。await必須（誤るとビルドエラー）。
 */

type PageParams = { id: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { id } = await params;
  const member = rosterById(id);
  return {
    title: `${member?.name ?? "不明"}さんの配置｜CROWD WEATHER`,
  };
}

export default async function StaffFixedPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { id } = await params;
  const member = rosterById(id);

  return (
    <div style={{ background: DAY.page, minHeight: "100vh", padding: "18px 12px" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        {member ? (
          <ScenarioProvider>
            <StaffConsole fixedMember={member} />
          </ScenarioProvider>
        ) : (
          <div
            style={{
              background: DAY.surface,
              border: `1px solid ${DAY.line}`,
              borderRadius: 12,
              padding: "16px 14px",
            }}
          >
            <div style={{ fontSize: 19, fontWeight: 700, color: DAY.text, marginBottom: 4 }}>
              不明なスタッフIDです。
            </div>
            <div style={{ fontSize: 15, color: DAY.textDim }}>本部に配布URLを確認してください。</div>
          </div>
        )}
      </div>
    </div>
  );
}
