import { describe, expect, it } from "vitest";
import { ROSTER, rosterById, rosterByName } from "./roster";

/**
 * 仮名簿の仕様固定。
 * いちばん守りたいのは (1) 23件・id連番の構成が崩れないこと (2) 姓の頭文字が
 * 全員ユニークなこと（地図マーカーに頭文字1文字だけを識別子として載せる運用の前提。
 * 頭文字が重複するとどの丸がどのスタッフか地図上で区別できなくなる）。
 */

describe("roster — 仮メンバー名簿", () => {
  it("23件・idはs01〜s23の連番", () => {
    expect(ROSTER).toHaveLength(23);
    ROSTER.forEach((m, i) => {
      expect(m.id).toBe(`s${String(i + 1).padStart(2, "0")}`);
    });
  });

  it("id・nameが全てユニーク", () => {
    expect(new Set(ROSTER.map((m) => m.id)).size).toBe(23);
    expect(new Set(ROSTER.map((m) => m.name)).size).toBe(23);
  });

  it("姓の頭文字が全員ユニーク（マーカー識別子として頭文字1文字を使う前提）", () => {
    const initials = ROSTER.map((m) => m.name[0]);
    expect(new Set(initials).size).toBe(23);
  });

  it("グループ→ロールの対応が正しい（メイン/フード/サブ→guide、給水→water、救護→aid、受付→reception）", () => {
    for (const m of ROSTER) {
      if (m.group === "メイン" || m.group === "フード" || m.group === "サブ") {
        expect(m.role).toBe("guide");
      } else if (m.group === "給水") {
        expect(m.role).toBe("water");
      } else if (m.group === "救護") {
        expect(m.role).toBe("aid");
      } else if (m.group === "受付") {
        expect(m.role).toBe("reception");
      }
    }
  });

  it("役割の構成人数: guide 11 / water 2 / aid 2 / reception 8", () => {
    const count = (role: string) => ROSTER.filter((m) => m.role === role).length;
    expect(count("guide")).toBe(11);
    expect(count("water")).toBe(2);
    expect(count("aid")).toBe(2);
    expect(count("reception")).toBe(8);
  });

  it("グループ別人数: メイン5・フード3・サブ3・給水2・救護2・受付8・遊軍0", () => {
    const count = (group: string) => ROSTER.filter((m) => m.group === group).length;
    expect(count("メイン")).toBe(5);
    expect(count("フード")).toBe(3);
    expect(count("サブ")).toBe(3);
    expect(count("給水")).toBe(2);
    expect(count("救護")).toBe(2);
    expect(count("受付")).toBe(8);
    expect(count("遊軍")).toBe(0);
  });

  it("rosterById / rosterByName が引ける（往復も一致）", () => {
    expect(rosterById("s01")?.name).toBe("佐藤");
    expect(rosterById("zzz")).toBeUndefined();
    const m = rosterByName("佐藤");
    expect(m?.id).toBe("s01");
    expect(rosterById(m!.id)?.name).toBe("佐藤");
    expect(rosterByName(rosterById("s01")!.name)?.id).toBe("s01");
  });
});
