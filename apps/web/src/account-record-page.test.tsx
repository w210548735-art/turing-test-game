import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountRecordPage, LogoutConfirmDialog } from "./App";
import { EMPTY_LOCAL_RECORD } from "./local-record";

const noop = vi.fn();

function renderAccountRecordPage(echoEnabled: boolean): string {
  return renderToStaticMarkup(
    <AccountRecordPage
      record={EMPTY_LOCAL_RECORD}
      accountUser={
        echoEnabled
          ? {
              id: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
              email: "player@example.com",
              playerNumber: 100001,
              displayName: "夜航观察员",
              status: "ACTIVE",
            }
          : undefined
      }
      echoEnabled={echoEnabled}
      onBack={noop}
      onEchoRecords={noop}
      onSaveDisplayName={async () => undefined}
      onChangePassword={async () => undefined}
      onCreator={noop}
      onSupport={noop}
      onFeedback={noop}
    />,
  );
}

describe("账户数据模式入口", () => {
  it("同时展示 1v1 对局与回声档案入口", () => {
    const markup = renderAccountRecordPage(true);
    expect(markup).toContain("1v1 对局");
    expect(markup).toContain("回声档案");
    expect(markup).toContain("云端鉴证记录");
    expect(markup).toContain("修改账号密码");
  });

  it("教学模式身份不能进入云端回声战绩", () => {
    const markup = renderAccountRecordPage(false);
    expect(markup).toContain('disabled=""><strong>回声档案');
    expect(markup).toContain("登录后查看");
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
