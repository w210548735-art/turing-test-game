import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountAccess } from "./App";

describe("账户入口", () => {
  it("重新发送验证邮件模式只要求邮箱，不要求再次输入密码", () => {
    const markup = renderToStaticMarkup(
      <AccountAccess
        mode="resend"
        loading={false}
        busy={false}
        error={null}
        message={null}
        hasResetToken={false}
        onModeChange={vi.fn()}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        onForgotPassword={vi.fn()}
        onResendVerification={vi.fn()}
        onResetPassword={vi.fn()}
        onLocalDemo={vi.fn()}
      />,
    );

    expect(markup).toContain("重新发送验证邮件");
    expect(markup).toContain('type="email"');
    expect(markup).not.toContain('type="password"');
  });
});
