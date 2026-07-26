import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  AuthError,
  AuthService,
  DeviceService,
  InMemoryAuthRepository,
  SessionService,
  VerificationTokenService,
  type EmailDelivery,
  type EmailMessage,
  type PasswordHasher,
} from "../src/auth/index.js";

class TestPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `test:${createHash("sha256").update(password).digest("hex")}`;
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return passwordHash === (await this.hash(password));
  }
}

class TestOutbox implements EmailDelivery {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push({
      ...message,
      expiresAt: new Date(message.expiresAt),
    });
  }
}

function expectAuthError(
  action: () => unknown,
  code: AuthError["code"],
): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof AuthError && error.code === code,
  );
}

async function expectAuthRejection(
  action: () => Promise<unknown>,
  code: AuthError["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof AuthError && error.code === code,
  );
}

function createFixture() {
  let now = new Date("2026-07-24T00:00:00.000Z");
  const repository = new InMemoryAuthRepository();
  const tokens = new VerificationTokenService(repository, () => now);
  const sessions = new SessionService(
    repository,
    { idleTtlMs: 60_000, absoluteTtlMs: 3_600_000 },
    () => now,
  );
  const outbox = new TestOutbox();
  const hasher = new TestPasswordHasher();
  const auth = new AuthService(
    repository,
    hasher,
    tokens,
    sessions,
    outbox,
    {},
    () => now,
  );
  return {
    auth,
    repository,
    sessions,
    outbox,
    setNow(value: Date) {
      now = value;
    },
  };
}

async function registerAndVerify(
  fixture: ReturnType<typeof createFixture>,
  email = "Alice@Example.com",
  password = "Quartz!River-2026",
) {
  await fixture.auth.register(email, password);
  const verification = fixture.outbox.messages.at(-1);
  assert.equal(verification?.purpose, "EMAIL_VERIFICATION");
  assert.ok(verification);
  return fixture.auth.verifyEmail(verification.token);
}

describe("AuthService 账户生命周期", () => {
  it("以幂等方式创建或覆盖已验证的 ROOT 账户", async () => {
    const fixture = createFixture();
    const first = await fixture.auth.upsertRootAccount(
      "owner@example.com",
      "First-Root!Password-2026",
    );
    assert.equal(first.role, "ROOT");
    assert.equal(first.status, "ACTIVE");
    assert.ok(first.emailVerifiedAt);

    const replaced = await fixture.auth.upsertRootAccount(
      "OWNER@example.com",
      "Second-Root!Password-2026",
    );
    assert.equal(replaced.id, first.id);
    assert.equal(replaced.role, "ROOT");
    await expectAuthRejection(
      () =>
        fixture.auth.login(
          "owner@example.com",
          "First-Root!Password-2026",
        ),
      "INVALID_CREDENTIALS",
    );
    const login = await fixture.auth.login(
      "owner@example.com",
      "Second-Root!Password-2026",
    );
    assert.equal(login.session.userId, first.id);
    const metrics = await fixture.repository.getAdminAccountMetrics(
      new Date("2026-07-24T00:00:59.999Z"),
    );
    assert.equal(metrics.verifiedUsers, 1);
    assert.equal(metrics.pendingVerificationUsers, 0);
    assert.equal(metrics.activeSessions, 1);
  });

  it("注册使用恒定公共结果并完成邮箱验证", async () => {
    const fixture = createFixture();
    const first = await fixture.auth.register(
      " Alice@Example.com ",
      "Quartz!River-2026",
    );
    const duplicate = await fixture.auth.register(
      "alice@example.com",
      "Different!Pass-2026",
    );
    assert.deepEqual(duplicate, first);
    assert.match(first.message, /收到验证邮件/);
    assert.match(first.message, /点击邮件中的激活链接后再返回登录/);
    assert.match(first.message, /检查垃圾箱/);
    assert.equal(fixture.outbox.messages.length, 1);

    const pending = await fixture.repository.findUserByCanonicalEmail(
      "alice@example.com",
    );
    assert.equal(pending?.emailOriginal, "Alice@Example.com");
    assert.equal(pending?.status, "PENDING_EMAIL");
    await expectAuthRejection(
      () => fixture.auth.login("alice@example.com", "Quartz!River-2026"),
      "INVALID_CREDENTIALS",
    );

    const message = fixture.outbox.messages[0];
    assert.ok(message);
    const active = await fixture.auth.verifyEmail(message.token);
    assert.equal(active.status, "ACTIVE");
    await expectAuthRejection(
      () => fixture.auth.verifyEmail(message.token),
      "TOKEN_CONSUMED",
    );
  });

  it("登录创建带风险上下文的会话且使用统一失败错误", async () => {
    const fixture = createFixture();
    const user = await registerAndVerify(fixture);
    const loggedIn = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
      {
        deviceId: "device-1",
        ipRiskKey: "ip-hash-1",
        userAgentSummary: "Browser 1",
      },
    );
    assert.equal(loggedIn.session.userId, user.id);
    assert.equal(loggedIn.session.deviceId, "device-1");
    assert.equal(loggedIn.session.ipRiskKey, "ip-hash-1");

    await expectAuthRejection(
      () => fixture.auth.login("missing@example.com", "Quartz!River-2026"),
      "INVALID_CREDENTIALS",
    );
    await expectAuthRejection(
      () => fixture.auth.login("alice@example.com", "wrong password"),
      "INVALID_CREDENTIALS",
    );
  });

  it("提供主路由所需的用户读取、Session 认证、轮换与当前撤销", async () => {
    const fixture = createFixture();
    const user = await registerAndVerify(fixture);
    const loggedIn = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
    );

    assert.equal((await fixture.auth.getUser(user.id)).id, user.id);
    assert.equal(
      (await fixture.auth.authenticateSession(loggedIn.token)).id,
      loggedIn.session.id,
    );
    const rotated = await fixture.auth.rotateSession(loggedIn.token);
    assert.notEqual(rotated.csrfToken, loggedIn.csrfToken);
    await expectAuthRejection(
      () => fixture.auth.authenticateSession(loggedIn.token),
      "SESSION_REVOKED",
    );
    assert.equal(
      await fixture.auth.revokeCurrentSession(rotated.token),
      true,
    );
    await expectAuthRejection(
      () => fixture.auth.authenticateSession(rotated.token),
      "SESSION_REVOKED",
    );
  });

  it("找回密码使用恒定结果且重置后撤销全部会话", async () => {
    const fixture = createFixture();
    await registerAndVerify(fixture);
    const first = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
    );
    const second = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
    );

    const knownResult = await fixture.auth.forgotPassword(
      "alice@example.com",
    );
    const unknownResult = await fixture.auth.forgotPassword(
      "missing@example.com",
    );
    assert.deepEqual(unknownResult, knownResult);
    const reset = fixture.outbox.messages.at(-1);
    assert.equal(reset?.purpose, "PASSWORD_RESET");
    assert.ok(reset);
    await fixture.auth.resetPassword(reset.token, "Nebula!Stone-2027");

    await expectAuthRejection(
      () => fixture.sessions.authenticate(first.token),
      "SESSION_REVOKED",
    );
    await expectAuthRejection(
      () => fixture.sessions.authenticate(second.token),
      "SESSION_REVOKED",
    );
    await fixture.auth.login("alice@example.com", "Nebula!Stone-2027");
    await expectAuthRejection(
      () => fixture.auth.login("alice@example.com", "Quartz!River-2026"),
      "INVALID_CREDENTIALS",
    );
  });

  it("修改密码保留当前会话并支持会话查询和撤销", async () => {
    const fixture = createFixture();
    const user = await registerAndVerify(fixture);
    const current = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
    );
    const other = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
    );
    await fixture.auth.changePassword(
      user.id,
      "Quartz!River-2026",
      "Orbit!Forest-2028",
      current.session.id,
    );
    assert.equal(
      (await fixture.sessions.authenticate(current.token)).userId,
      user.id,
    );
    await expectAuthRejection(
      () => fixture.sessions.authenticate(other.token),
      "SESSION_REVOKED",
    );

    const extra = await fixture.auth.login(
      "alice@example.com",
      "Orbit!Forest-2028",
    );
    assert.equal((await fixture.auth.listSessions(user.id)).length, 3);
    assert.equal(
      await fixture.auth.revokeSession(user.id, extra.session.id),
      true,
    );
    assert.equal(
      await fixture.auth.revokeOthers(user.id, current.session.id),
      0,
    );
  });

  it("状态门禁区分受限账号登录和正式匹配", async () => {
    const fixture = createFixture();
    const user = await registerAndVerify(fixture);
    user.status = "LIMITED";
    await fixture.repository.updateUser(user);
    await fixture.auth.login("alice@example.com", "Quartz!River-2026");
    assert.equal(
      (await fixture.auth.assertAccountCapability(user.id, "ACCOUNT")).status,
      "LIMITED",
    );
    await expectAuthRejection(
      () => fixture.auth.assertAccountCapability(user.id, "MATCH"),
      "ACCOUNT_RESTRICTED",
    );
  });

  it("导出不含密钥摘要，删除后匿名化账号并撤销会话", async () => {
    const fixture = createFixture();
    const user = await registerAndVerify(fixture);
    const device = new DeviceService(fixture.repository);
    await device.issue(user.id);
    const session = await fixture.auth.login(
      "alice@example.com",
      "Quartz!River-2026",
    );
    const exported = await fixture.auth.exportAccountSummary(user.id);
    assert.equal(exported.account.email, "Alice@Example.com");
    assert.ok(exported.account.playerNumber >= 100_001);
    assert.equal(exported.account.displayName, "图灵玩家");
    assert.equal(exported.sessions.length, 1);
    assert.equal(exported.devices.length, 1);
    assert.equal("passwordHash" in exported.account, false);
    assert.equal("tokenHash" in exported.sessions[0]!, false);

    fixture.setNow(new Date("2026-07-24T00:05:00.000Z"));
    await fixture.auth.deleteAccount(user.id, "Quartz!River-2026");
    const deleted = await fixture.repository.findUserById(user.id);
    assert.equal(deleted?.status, "DELETED");
    assert.match(deleted?.emailCanonical ?? "", /@deleted\.invalid$/u);
    assert.equal(deleted?.displayName, "已删除用户");
    assert.equal(deleted?.nickname, "已删除用户");
    assert.equal(deleted?.typingStatus, "");
    assert.equal(
      await fixture.repository.findUserByCanonicalEmail("alice@example.com"),
      undefined,
    );
    await expectAuthRejection(
      () => fixture.sessions.authenticate(session.token),
      "SESSION_REVOKED",
    );
    await expectAuthRejection(
      () => fixture.auth.exportAccountSummary(user.id),
      "ACCOUNT_RESTRICTED",
    );
  });
});
