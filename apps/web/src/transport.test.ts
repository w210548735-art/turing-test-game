import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapAccount,
  changeAccountPassword,
  DemoTransport,
  forgotAccountPassword,
  loginAccount,
  logoutAccount,
  registerAccount,
  resetAccountPassword,
  saveAccountProfile,
  saveProfile,
  verifyAccountEmail,
} from "./transport";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("教学模式匹配", () => {
  it("依次经过寻找对手和五秒入场后才进入房间", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const events: Array<{ type: string }> = [];
    const transport = new DemoTransport({
      onEvent: (event) => events.push(event),
      onConnectionChange: () => undefined,
    });

    transport.send({ type: "match.join" });
    expect(events.map((event) => event.type)).toEqual([
      "match.searching",
    ]);

    vi.advanceTimersByTime(5_000);
    expect(events.some((event) => event.type === "match.admission")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "match.found")).toBe(
      false,
    );

    vi.advanceTimersByTime(5_000);
    expect(events.at(-1)?.type).toBe("match.found");
    expect(
      (events.at(-1) as { opponentLabel?: string }).opponentLabel,
    ).toBe("晚风");
  });
});

describe("Cookie 会话传输", () => {
  it("资料修改携带 Cookie 凭据和 CSRF，不发送 Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ profile: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await saveProfile("csrf-token", {
      nickname: "观察者",
      typingStatus: "正在验证假设…",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-token",
    });
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});

describe("账户传输", () => {
  it("注册使用 Cookie 凭据且不发送 Authorization", async () => {
    const activationMessage =
      "注册请求已提交。如果该邮箱可用于注册，你会收到验证邮件；请点击邮件中的激活链接后再返回登录。若暂未找到，请检查垃圾箱。";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          message: activationMessage,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerAccount({
      email: "member@example.com",
      password: "Correct-Horse-123",
    });

    expect(result.message).toBe(activationMessage);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/register");
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("注册参数先经过表单 Schema，不发送无效短密码", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      registerAccount({
        email: "member@example.com",
        password: "too-short",
      }),
    ).rejects.toThrow("密码至少需要 12 个字符。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("注册邮箱无效时显示中文提示，不暴露校验器 JSON", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      registerAccount({
        email: "not-an-email",
        password: "Correct-Horse-123",
      }),
    ).rejects.toThrow("请输入有效的邮箱地址。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("登录短密码显示中文提示且不发送请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loginAccount({
        email: "member@example.com",
        password: "short",
      }),
    ).rejects.toThrow("密码至少需要 12 个字符。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("找回密码邮箱无效时显示中文提示", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forgotAccountPassword({ email: "not-an-email" }),
    ).rejects.toThrow("请输入有效的邮箱地址。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("重置密码过短时显示中文提示", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resetAccountPassword({
        token: "valid-reset-token-with-enough-length",
        newPassword: "short",
      }),
    ).rejects.toThrow("密码至少需要 12 个字符。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("邮箱验证链接无效时显示中文提示", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyAccountEmail({ token: "short" })).rejects.toThrow(
      "验证链接无效或已过期。",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("登录只返回内存所需的 CSRF 与一次性票据", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          user: {
            id: "0d602197-3770-4b3e-8222-705ba000b7fa",
            email: "member@example.com",
            playerNumber: 100001,
            displayName: "图灵玩家",
            status: "ACTIVE",
          },
          csrfToken: "csrf-token-with-enough-entropy",
          sessionExpiresAt: Date.now() + 60_000,
          wsTicket: "single-use-ticket-with-enough-entropy",
          wsTicketExpiresAt: Date.now() + 30_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await loginAccount({
      email: "member@example.com",
      password: "Correct-Horse-123",
    });

    expect(session.authenticated).toBe(true);
    expect("token" in session).toBe(false);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("更新全局账户名称时不会发送 1v1 临时资料", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: "0d602197-3770-4b3e-8222-705ba000b7fa",
            email: "member@example.com",
            playerNumber: 100001,
            displayName: "夜航观察员",
            status: "ACTIVE",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = await saveAccountProfile(
      "csrf-token-with-enough-entropy",
      { displayName: "夜航观察员" },
    );

    expect(user.displayName).toBe("夜航观察员");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/account/profile");
    expect(JSON.parse(String(init.body))).toEqual({
      displayName: "夜航观察员",
    });
  });

  it("修改密码携带当前密码、新密码、Cookie 与 CSRF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ changed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await changeAccountPassword("csrf-token-with-enough-entropy", {
      currentPassword: "Current-Password-2026!",
      newPassword: "New-Password-2027!",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/auth/password/change");
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-token-with-enough-entropy",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: "Current-Password-2026!",
      newPassword: "New-Password-2027!",
    });
  });

  it("bootstrap 的 401 表示没有可恢复会话", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "未登录" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapAccount()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/bootstrap", {
      method: "POST",
      credentials: "include",
      headers: {},
    });
  });

  it("注销携带 CSRF 但不发送 Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ loggedOut: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await logoutAccount("csrf-token-with-enough-entropy");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      "X-CSRF-Token": "csrf-token-with-enough-entropy",
    });
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});
