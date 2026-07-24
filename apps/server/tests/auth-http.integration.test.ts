import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type EmailDelivery,
  type EmailMessage,
  InMemoryAuthRepository,
  type PasswordHasher,
} from "../src/auth/index.js";
import { buildServer, type ServerContext } from "../src/server.js";

const TEST_ORIGIN = "http://localhost:5173";

class TestPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `test:${password}`;
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return passwordHash === `test:${password}`;
  }
}

class TestOutbox implements EmailDelivery {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }

  latest(purpose: EmailMessage["purpose"]): EmailMessage {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.purpose === purpose) return message;
    }
    assert.fail(`缺少 ${purpose} 测试邮件`);
  }
}

function cookieHeader(
  setCookie: string | string[] | undefined,
): string {
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const pairs = values.map((value) => value.split(";", 1)[0]);
  assert.equal(pairs.length, 2, "账户响应应同时设置会话和设备 Cookie");
  return pairs.join("; ");
}

describe("账户认证 HTTP 路由", () => {
  let context: ServerContext;
  const outbox = new TestOutbox();

  before(async () => {
    process.env.LOG_LEVEL = "silent";
    process.env.NODE_ENV = "development";
    process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
    context = await buildServer({
      authRepository: new InMemoryAuthRepository(),
      emailDelivery: outbox,
      passwordHasher: new TestPasswordHasher(),
      registrationOpen: true,
    });
  });

  after(async () => {
    await context.app.close();
  });

  it("完成注册、验证、登录、bootstrap、改资料、重置密码和注销", async () => {
    const email = "account-route@example.com";
    const oldPassword = "Valid-Password-2026!";
    const newPassword = "Changed-Password-2026!";

    const registration = await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password: oldPassword },
    });
    assert.equal(registration.statusCode, 202);
    assert.deepEqual(registration.json(), {
      accepted: true,
      message: "如果该邮箱可以注册，我们会向其发送验证邮件。",
    });

    const unverifiedLogin = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password: oldPassword },
    });
    assert.equal(unverifiedLogin.statusCode, 401);

    const verification = await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { origin: TEST_ORIGIN },
      payload: {
        token: outbox.latest("EMAIL_VERIFICATION").token,
      },
    });
    assert.equal(verification.statusCode, 200);
    assert.deepEqual(verification.json(), { verified: true });

    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password: oldPassword },
    });
    assert.equal(login.statusCode, 200);
    const loginBody = login.json<{
      authenticated: true;
      csrfToken: string;
      user: { email: string; status: string };
      wsTicket: string;
    }>();
    assert.equal(loginBody.authenticated, true);
    assert.equal(loginBody.user.email, email);
    assert.equal(loginBody.user.status, "ACTIVE");
    assert.equal(typeof loginBody.wsTicket, "string");
    assert.equal(
      Object.prototype.hasOwnProperty.call(loginBody, "token"),
      false,
    );
    const firstCookies = cookieHeader(login.headers["set-cookie"]);

    const profile = await context.app.inject({
      method: "PUT",
      url: "/api/profile",
      headers: {
        origin: TEST_ORIGIN,
        cookie: firstCookies,
        "x-csrf-token": loginBody.csrfToken,
      },
      payload: {
        nickname: "账户玩家",
        typingStatus: "正在验证账户链路…",
      },
    });
    assert.equal(profile.statusCode, 200);

    const bootstrap = await context.app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: {
        origin: TEST_ORIGIN,
        cookie: firstCookies,
      },
    });
    assert.equal(bootstrap.statusCode, 200);
    const bootstrapBody = bootstrap.json<{ csrfToken: string }>();
    assert.notEqual(bootstrapBody.csrfToken, loginBody.csrfToken);
    const rotatedCookies = cookieHeader(bootstrap.headers["set-cookie"]);
    assert.notEqual(rotatedCookies, firstCookies);

    const oldSession = await context.app.inject({
      method: "POST",
      url: "/api/ws-ticket",
      headers: {
        origin: TEST_ORIGIN,
        cookie: firstCookies,
        "x-csrf-token": loginBody.csrfToken,
      },
    });
    assert.equal(oldSession.statusCode, 401);

    const forgot = await context.app.inject({
      method: "POST",
      url: "/api/auth/password/forgot",
      headers: { origin: TEST_ORIGIN },
      payload: { email },
    });
    assert.equal(forgot.statusCode, 202);

    const reset = await context.app.inject({
      method: "POST",
      url: "/api/auth/password/reset",
      headers: { origin: TEST_ORIGIN },
      payload: {
        token: outbox.latest("PASSWORD_RESET").token,
        newPassword,
      },
    });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json(), { reset: true });

    const revokedBootstrap = await context.app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: {
        origin: TEST_ORIGIN,
        cookie: rotatedCookies,
      },
    });
    assert.equal(revokedBootstrap.statusCode, 401);

    const relogin = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password: newPassword },
    });
    assert.equal(relogin.statusCode, 200);
    const reloginBody = relogin.json<{ csrfToken: string }>();
    const reloginCookies = cookieHeader(relogin.headers["set-cookie"]);

    const logout = await context.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: TEST_ORIGIN,
        cookie: reloginCookies,
        "x-csrf-token": reloginBody.csrfToken,
      },
    });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(logout.json(), { loggedOut: true });
  });

  it("拒绝缺失 Origin、错误 CSRF 与重复使用验证 Token", async () => {
    const email = "account-security@example.com";
    const password = "Another-Valid-Password-2026!";
    await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    const token = outbox.latest("EMAIL_VERIFICATION").token;

    const missingOrigin = await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      payload: { token },
    });
    assert.equal(missingOrigin.statusCode, 403);

    const verified = await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { origin: TEST_ORIGIN },
      payload: { token },
    });
    assert.equal(verified.statusCode, 200);

    const replayed = await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { origin: TEST_ORIGIN },
      payload: { token },
    });
    assert.equal(replayed.statusCode, 400);

    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const badCsrf = await context.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": "invalid-csrf-token-that-is-long-enough",
      },
    });
    assert.equal(badCsrf.statusCode, 403);
  });
});
