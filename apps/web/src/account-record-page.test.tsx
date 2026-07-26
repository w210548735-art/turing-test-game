import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountSettingsPage } from "./account/AccountSettingsPage";
import { LogoutConfirmDialog } from "./App";
import { EMPTY_LOCAL_RECORD } from "./local-record";
import { PlayerRecordsPage } from "./records/PlayerRecordsPage";

const noop = vi.fn();
const accountUser = {
  id: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
  email: "player@example.com",
  playerNumber: 100001,
  displayName: "夜航观察员",
  status: "ACTIVE" as const,
  role: "PLAYER" as const,
};

describe("玩家档案与账户设置入口", () => {
  it("玩家档案只展示统一战绩入口，不混入账户表单", () => {
    const markup = renderToStaticMarkup(
      <PlayerRecordsPage
        record={EMPTY_LOCAL_RECORD}
        accountUser={accountUser}
        mode="duel"
        onModeChange={noop}
        onBack={noop}
        onSettings={noop}
      />,
    );
    expect(markup).toContain("1v1 战绩");
    expect(markup).toContain("回声鉴证");
    expect(markup).toContain("账户设置");
    expect(markup).not.toContain("当前密码");
    expect(markup).not.toContain("在这里切换查看");
  });

  it("教学模式身份不能进入云端回声战绩", () => {
    const markup = renderToStaticMarkup(
      <PlayerRecordsPage
        record={EMPTY_LOCAL_RECORD}
        mode="duel"
        onModeChange={noop}
        onBack={noop}
        onSettings={noop}
      />,
    );
    expect(markup).toContain("登录后查看");
    expect(markup).toContain("账户登录");
  });

  it("账户设置集中展示安全与支持操作，不展示战绩", () => {
    const markup = renderToStaticMarkup(
      <AccountSettingsPage
        accountUser={accountUser}
        busy={false}
        onBack={noop}
        onSaveDisplayName={async () => undefined}
        onChangePassword={async () => undefined}
        onLogout={noop}
        onDeleteAccount={async () => undefined}
        onCreator={noop}
        onSupport={noop}
        onFeedback={noop}
      />,
    );
    expect(markup).toContain("账户设置");
    expect(markup).toContain("修改账号密码");
    expect(markup).toContain("注销账号");
    expect(markup).not.toContain("判断命中率");
  });

  it("退出账户前展示独立二次确认", () => {
    const markup = renderToStaticMarkup(
      <LogoutConfirmDialog
        busy={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(markup).toContain("确定退出当前账号？");
    expect(markup).toContain("继续留在这里");
  });
});
