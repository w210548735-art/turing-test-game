import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountSettingsPage } from "./AccountSettingsPage";

const noop = vi.fn();
const noopAsync = vi.fn(async () => undefined);

describe("独立账户设置页面", () => {
  it("只承载账户操作，不混入玩家战绩", () => {
    const markup = renderToStaticMarkup(
      <AccountSettingsPage
        accountUser={{
          id: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
          email: "player@example.com",
          playerNumber: 100001,
          displayName: "夜航观察员",
          status: "ACTIVE",
          role: "PLAYER",
        }}
        busy={false}
        onBack={noop}
        onSaveDisplayName={noopAsync}
        onChangePassword={noopAsync}
        onLogout={noop}
        onDeleteAccount={noopAsync}
        onCreator={noop}
        onSupport={noop}
        onFeedback={noop}
      />,
    );

    expect(markup).toContain("账户设置");
    expect(markup).toContain('aria-label="当前账户身份"');
    expect(markup).toContain("GLOBAL IDENTITY");
    expect(markup).toContain("夜航观察员");
    expect(markup).toContain("PLAYER");
    expect(markup).toContain("全局账户名称");
    expect(markup).toContain("修改账号密码");
    expect(markup).toContain("退出当前账号");
    expect(markup).toContain("注销账号");
    expect(markup).toContain("问题 / Bug 反馈");
    expect(markup).not.toContain("打开运营后台");
    expect(markup).not.toContain("历史战绩");
    expect(markup).not.toContain("判断命中率");
  });

  it("只向 ROOT 账户显示运营后台入口", () => {
    const markup = renderToStaticMarkup(
      <AccountSettingsPage
        accountUser={{
          id: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
          email: "owner@example.com",
          playerNumber: 100001,
          displayName: "夜航观察员",
          status: "ACTIVE",
          role: "ROOT",
        }}
        busy={false}
        onBack={noop}
        onSaveDisplayName={noopAsync}
        onChangePassword={noopAsync}
        onLogout={noop}
        onDeleteAccount={noopAsync}
        onAdmin={noop}
        onCreator={noop}
        onSupport={noop}
        onFeedback={noop}
      />,
    );
    expect(markup).toContain("打开运营后台");
    expect(markup).toContain("ROOT");
  });
});
