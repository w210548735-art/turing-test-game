import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type EmailDelivery,
  type EmailMessage,
  InMemoryAuthRepository,
  type PasswordHasher,
} from "../src/auth/index.js";
import {
  MemoryFeedbackRepository,
  type FeedbackDigestEmailMessage,
  type FeedbackEmailDelivery,
} from "../src/feedback/index.js";
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

class TestOutbox implements EmailDelivery, FeedbackEmailDelivery {
  readonly messages: EmailMessage[] = [];
  readonly feedbackMessages: FeedbackDigestEmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }

  async sendFeedbackDigest(
    message: FeedbackDigestEmailMessage,
  ): Promise<void> {
    this.feedbackMessages.push(message);
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
  const feedbackRepository = new MemoryFeedbackRepository();

  before(async () => {
    process.env.LOG_LEVEL = "silent";
    process.env.NODE_ENV = "development";
    process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
    feedbackRepository.now = () =>
      new Date("2026-07-25T01:59:00.000Z");
    context = await buildServer({
      authRepository: new InMemoryAuthRepository(),
      emailDelivery: outbox,
      passwordHasher: new TestPasswordHasher(),
      registrationOpen: true,
      feedbackRepository,
      feedbackDelivery: outbox,
      feedbackRecipientEmail: "admin@example.com",
      feedbackDigest: {
        now: () => new Date("2026-07-25T02:00:00.000Z"),
        intervalMs: 24 * 60 * 60_000,
        leaseOwner: "auth-http-test-worker",
        autoStart: false,
      },
    });
  });

  after(async () => {
    await context.app.close();
  });

  it("只允许账户级 ROOT 读取运营统计面板", async () => {
    const normalEmail = "dashboard-player@example.com";
    const normalPassword = "Dashboard-Player!2026";
    await context.auth.repository.createUser({
      emailCanonical: normalEmail,
      passwordHash: `test:${normalPassword}`,
      status: "ACTIVE",
      role: "PLAYER",
      emailVerifiedAt: new Date("2026-07-26T01:00:00.000Z"),
    });
    const normalLogin = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email: normalEmail, password: normalPassword },
    });
    assert.equal(normalLogin.statusCode, 200);
    const forbidden = await context.app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookieHeader(normalLogin.headers["set-cookie"]),
      },
    });
    assert.equal(forbidden.statusCode, 403);

    const rootEmail = "dashboard-root@example.com";
    const rootPassword = "Quartz!Nebula-Root-2026";
    await context.auth.service.upsertRootAccount(rootEmail, rootPassword);
    const rootLogin = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email: rootEmail, password: rootPassword },
    });
    assert.equal(rootLogin.statusCode, 200);
    assert.equal(rootLogin.json().user.role, "ROOT");
    const dashboard = await context.app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookieHeader(rootLogin.headers["set-cookie"]),
      },
    });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.json().databaseMode, "memory-demo");
    assert.equal(dashboard.json().daily.length, 7);
    assert.ok(dashboard.json().metrics.registeredUsers >= 2);
    assert.ok(dashboard.json().metrics.verifiedUsers >= 2);
    assert.ok(dashboard.json().metrics.activeSessions >= 2);
    assert.equal(dashboard.json().metrics.roomCapacity, 50);
    assert.equal(dashboard.json().metrics.pendingFeedback, 0);
    assert.equal(dashboard.json().metrics.pendingReports, 0);
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
      message:
        "注册请求已提交。如果该邮箱可用于注册，你会收到验证邮件；请点击邮件中的激活链接后再返回登录。若暂未找到，请检查垃圾箱。",
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
      user: {
        email: string;
        playerNumber: number;
        displayName: string;
        status: string;
      };
      wsTicket: string;
    }>();
    assert.equal(loginBody.authenticated, true);
    assert.equal(loginBody.user.email, email);
    assert.ok(loginBody.user.playerNumber >= 100_001);
    assert.equal(loginBody.user.displayName, "图灵玩家");
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

    const accountProfile = await context.app.inject({
      method: "PUT",
      url: "/api/account/profile",
      headers: {
        origin: TEST_ORIGIN,
        cookie: firstCookies,
        "x-csrf-token": loginBody.csrfToken,
      },
      payload: {
        displayName: "夜航观察员",
      },
    });
    assert.equal(accountProfile.statusCode, 200);
    assert.deepEqual(accountProfile.json(), {
      user: {
        id: accountProfile.json().user.id,
        email,
        playerNumber: loginBody.user.playerNumber,
        displayName: "夜航观察员",
        status: "ACTIVE",
        role: "PLAYER",
      },
    });

    const changedPassword = "Intermediate-Password-2027!";
    const passwordChange = await context.app.inject({
      method: "PUT",
      url: "/api/auth/password/change",
      headers: {
        origin: TEST_ORIGIN,
        cookie: firstCookies,
        "x-csrf-token": loginBody.csrfToken,
      },
      payload: {
        currentPassword: oldPassword,
        newPassword: changedPassword,
      },
    });
    assert.equal(passwordChange.statusCode, 200);
    assert.deepEqual(passwordChange.json(), { changed: true });

    const rejectedOldPassword = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password: oldPassword },
    });
    assert.equal(rejectedOldPassword.statusCode, 401);

    const bootstrap = await context.app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: {
        origin: TEST_ORIGIN,
        cookie: firstCookies,
      },
    });
    assert.equal(bootstrap.statusCode, 200);
    const bootstrapBody = bootstrap.json<{
      csrfToken: string;
      user: {
        playerNumber: number;
        displayName: string;
      };
    }>();
    assert.notEqual(bootstrapBody.csrfToken, loginBody.csrfToken);
    assert.equal(
      bootstrapBody.user.playerNumber,
      loginBody.user.playerNumber,
    );
    assert.equal(bootstrapBody.user.displayName, "夜航观察员");
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

  it("账户注销要求密码与确认文本，并撤销全部会话", async () => {
    const email = "delete-account-route@example.com";
    const password = "Delete-Account-Password-2026!";
    await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { origin: TEST_ORIGIN },
      payload: {
        token: outbox.latest("EMAIL_VERIFICATION").token,
      },
    });
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    const body = login.json<{ csrfToken: string }>();
    const cookies = cookieHeader(login.headers["set-cookie"]);

    const invalidConfirmation = await context.app.inject({
      method: "DELETE",
      url: "/api/account",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        currentPassword: password,
        confirmation: "删除",
      },
    });
    assert.equal(invalidConfirmation.statusCode, 400);

    const wrongPassword = await context.app.inject({
      method: "DELETE",
      url: "/api/account",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        currentPassword: "Wrong-Password-2026!",
        confirmation: "注销",
      },
    });
    assert.equal(wrongPassword.statusCode, 401);

    const deleted = await context.app.inject({
      method: "DELETE",
      url: "/api/account",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        currentPassword: password,
        confirmation: "注销",
      },
    });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deleted.json(), { deleted: true });

    const bootstrap = await context.app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
    });
    assert.equal(bootstrap.statusCode, 401);

    const relogin = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    assert.equal(relogin.statusCode, 401);
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

  it("仅允许已登录账户携带 CSRF 提交结构化反馈", async () => {
    const email = "feedback-route@example.com";
    const password = "Feedback-Password-2026!";
    await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { origin: TEST_ORIGIN },
      payload: {
        token: outbox.latest("EMAIL_VERIFICATION").token,
      },
    });
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    const body = login.json<{ csrfToken: string; user: { id: string } }>();
    const cookies = cookieHeader(login.headers["set-cookie"]);

    const invalid = await context.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        category: "bug",
        title: "短",
        details: "也太短",
      },
    });
    assert.equal(invalid.statusCode, 400);

    const accepted = await context.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        category: "suggestion",
        title: "希望增加历史对局筛选",
        details: "希望可以按照真人局和 AI 局筛选历史对局，谢谢。",
      },
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json<{ accepted: boolean }>().accepted, true);
    assert.equal(feedbackRepository.records.at(-1)?.userId, body.user.id);
    assert.equal(
      feedbackRepository.records.at(-1)?.deliveryStatus,
      "pending",
    );
    assert.equal(outbox.feedbackMessages.length, 0);
    await context.feedback.worker?.runOnce();
    assert.equal(
      feedbackRepository.records.at(-1)?.deliveryStatus,
      "sent",
    );
    assert.equal(outbox.feedbackMessages.at(-1)?.to, "admin@example.com");

    for (let index = 0; index < 4; index += 1) {
      const withinLimit = await context.app.inject({
        method: "POST",
        url: "/api/feedback",
        headers: {
          origin: TEST_ORIGIN,
          cookie: cookies,
          "x-csrf-token": body.csrfToken,
        },
        payload: {
          category: "other",
          title: `补充反馈 ${index + 1}`,
          details: `这是同一账户当天允许提交的第 ${index + 2} 条反馈内容。`,
        },
      });
      assert.equal(withinLimit.statusCode, 202);
    }
    const rateLimited = await context.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        category: "other",
        title: "超出每日限额",
        details: "同一账户当天提交第六条反馈时应被组合限流拒绝。",
      },
    });
    assert.equal(rateLimited.statusCode, 429);

    const anonymous = await context.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { origin: TEST_ORIGIN },
      payload: {
        category: "other",
        title: "匿名反馈",
        details: "这条反馈不应被匿名账户提交。",
      },
    });
    assert.equal(anonymous.statusCode, 401);
  });

  it("回声档案接口要求账户、Origin 与写请求 CSRF", async () => {
    const anonymous = await context.app.inject({
      method: "POST",
      url: "/api/echo/assignments",
      headers: { origin: TEST_ORIGIN },
    });
    assert.equal(anonymous.statusCode, 401);

    const email = "echo-route@example.com";
    const password = "Quartz-Nebula-Password-2026!";
    const registration = await context.app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    assert.equal(registration.statusCode, 202);
    const verification = await context.app.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      headers: { origin: TEST_ORIGIN },
      payload: {
        token: outbox.latest("EMAIL_VERIFICATION").token,
      },
    });
    assert.equal(verification.statusCode, 200);
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200);
    const body = login.json<{ csrfToken: string }>();
    const cookies = cookieHeader(login.headers["set-cookie"]);

    const missingCsrf = await context.app.inject({
      method: "POST",
      url: "/api/echo/assignments",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const unavailable = await context.app.inject({
      method: "POST",
      url: "/api/echo/assignments",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
    });
    assert.equal(unavailable.statusCode, 404);
    assert.equal(
      unavailable.json<{ error: { code: string } }>().error.code,
      "ECHO_ARCHIVE_UNAVAILABLE",
    );

    const missingOrigin = await context.app.inject({
      method: "PUT",
      url: "/api/games/00000000-0000-4000-8000-000000000001/archive-consent",
      headers: {
        cookie: cookies,
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        decision: "approve",
        clientRequestId: "00000000-0000-4000-8000-000000000002",
      },
    });
    assert.equal(missingOrigin.statusCode, 403);

    const missingJudgmentCsrf = await context.app.inject({
      method: "POST",
      url: "/api/echo/assignments/00000000-0000-4000-8000-000000000003/judgment",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
      payload: {
        guessA: "human",
        confidenceA: 50,
        guessB: "ai",
        confidenceB: 50,
        clientRequestId: "00000000-0000-4000-8000-000000000004",
      },
    });
    assert.equal(missingJudgmentCsrf.statusCode, 403);

    const commentsWithoutOrigin = await context.app.inject({
      method: "GET",
      url: "/api/echo/assignments/00000000-0000-4000-8000-000000000003/comments",
      headers: { cookie: cookies },
    });
    assert.equal(commentsWithoutOrigin.statusCode, 403);

    const recordsFromForbiddenOrigin = await context.app.inject({
      method: "GET",
      url: "/api/echo/records",
      headers: {
        origin: "https://attacker.example",
        cookie: cookies,
      },
    });
    assert.equal(recordsFromForbiddenOrigin.statusCode, 403);

    const recordsWithoutDatabase = await context.app.inject({
      method: "GET",
      url: "/api/echo/records",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
    });
    assert.equal(recordsWithoutDatabase.statusCode, 503);
    assert.equal(
      recordsWithoutDatabase.json<{ error: { code: string } }>().error.code,
      "ECHO_RECORDS_UNAVAILABLE",
    );

    const commentsLocked = await context.app.inject({
      method: "GET",
      url: "/api/echo/assignments/00000000-0000-4000-8000-000000000003/comments",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
    });
    assert.equal(commentsLocked.statusCode, 403);
    assert.equal(
      commentsLocked.json<{ error: { code: string } }>().error.code,
      "ECHO_COMMENTS_LOCKED",
    );

    const commentWithoutCsrf = await context.app.inject({
      method: "POST",
      url: "/api/echo/assignments/00000000-0000-4000-8000-000000000003/comments",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
      payload: {
        eventSequence: 2,
        content: "这是一条不会被提交的测试批注",
        clientRequestId: "00000000-0000-4000-8000-000000000005",
      },
    });
    assert.equal(commentWithoutCsrf.statusCode, 403);

    const likeWithoutCsrf = await context.app.inject({
      method: "PUT",
      url: "/api/echo/assignments/00000000-0000-4000-8000-000000000003/comments/00000000-0000-4000-8000-000000000006/like",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookies,
      },
    });
    assert.equal(likeWithoutCsrf.statusCode, 403);
  });
});
