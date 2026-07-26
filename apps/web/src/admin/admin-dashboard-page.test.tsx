import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminDashboardPage } from "./AdminDashboardPage";

describe("ROOT 运营后台", () => {
  it("展示核心总量、趋势图与刷新入口", () => {
    const markup = renderToStaticMarkup(
      <AdminDashboardPage
        loading={false}
        error={null}
        data={{
          generatedAt: "2026-07-26T02:00:00.000Z",
          databaseMode: "memory-demo",
          metrics: {
            registeredUsers: 42,
            newUsersToday: 3,
            newUsers7d: 12,
            previous7dUsers: 8,
            visitsToday: 18,
            visits7d: 96,
            previous7dVisits: 75,
            verifiedUsers: 36,
            pendingVerificationUsers: 6,
            activeSessions: 11,
            onlineUsers: 7,
            totalGames: 128,
            activeGames: 4,
            humanGames: 91,
            aiGames: 37,
            waitingPlayers: 3,
            admittingPlayers: 2,
            roomCapacity: 50,
            savedEchoArchives: 21,
            pendingFeedback: 4,
            pendingReports: 2,
            aiRequestsThisHour: 9,
            tokensToday: 15_800,
            tokenBudgetToday: 1_000_000,
          },
          daily: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-07-${String(20 + index).padStart(2, "0")}`,
            registrations: index,
            visits: index * 3,
          })),
        }}
        onBack={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(markup).toContain("运营后台");
    expect(markup).toContain("注册用户");
    expect(markup).toContain("在线人数");
    expect(markup).toContain("当前对局");
    expect(markup).toContain("Token");
    expect(markup).toContain("回声档案");
    expect(markup).toContain("账户健康");
    expect(markup).toContain("匹配态势");
    expect(markup).toContain("运营待办");
    expect(markup).toContain("账户邮箱验证率");
    expect(markup).toContain("真人对局 91，AI 对局 37");
    expect(markup).toContain("aria-label=\"近 7 日注册趋势\"");
    expect(markup).toContain("aria-label=\"近 7 日访问趋势\"");
  });
});
