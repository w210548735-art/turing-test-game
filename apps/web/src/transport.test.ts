import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapAccount,
  loginAccount,
  logoutAccount,
  registerAccount,
  saveProfile,
} from "./transport";

afterEach(() => {
  vi.unstubAllGlobals();
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          message: "如果地址可用，请查收验证邮件。",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await registerAccount({
      email: "member@example.com",
      password: "Correct-Horse-123",
    });

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
    ).rejects.toThrow();
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
