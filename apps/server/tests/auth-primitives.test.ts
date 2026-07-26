import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthError,
  Argon2idPasswordHasher,
  DeviceService,
  DEFAULT_ACCOUNT_SESSION_POLICY,
  hashOpaqueToken,
  InMemoryAuthRepository,
  SessionService,
  validatePassword,
  VerificationTokenService,
  canonicalizeEmail,
} from "../src/auth/index.js";

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

describe("认证基础能力", () => {
  it("默认账户会话固定为空闲两小时、绝对七天且没有保持登录分支", async () => {
    assert.deepEqual(DEFAULT_ACCOUNT_SESSION_POLICY, {
      idleTtlMs: 2 * 60 * 60_000,
      absoluteTtlMs: 7 * 24 * 60 * 60_000,
    });
    const repository = new InMemoryAuthRepository();
    const sessions = new SessionService(repository);
    const issued = await sessions.create("user-default-policy");
    assert.equal(
      issued.session.idleExpiresAt.getTime() -
        issued.session.lastSeenAt.getTime(),
      2 * 60 * 60_000,
    );
    assert.equal(
      issued.session.absoluteExpiresAt.getTime() -
        issued.session.createdAt.getTime(),
      7 * 24 * 60 * 60_000,
    );
  });

  it("使用 Argon2id 独立盐异步哈希并统一处理损坏哈希", async () => {
    const hasher = new Argon2idPasswordHasher({
      memoryCostKiB: 8_192,
      timeCost: 1,
    });
    const first = await hasher.hash("霜林!v7-Quartz-River");
    const second = await hasher.hash("霜林!v7-Quartz-River");
    assert.match(first, /^\$argon2id\$/u);
    assert.notEqual(first, second);
    assert.equal(
      await hasher.verify(first, "霜林!v7-Quartz-River"),
      true,
    );
    assert.equal(await hasher.verify(first, "错误密码-Quartz"), false);
    assert.equal(await hasher.verify("not-an-argon2-hash", "任意密码"), false);
  });

  it("规范化邮箱但不执行服务商别名改写", () => {
    assert.equal(
      canonicalizeEmail("  Ｔｅｓｔ+Demo@Example.COM  "),
      "test+demo@example.com",
    );
    expectAuthError(() => canonicalizeEmail("not-an-email"), "INVALID_EMAIL");
  });

  it("拒绝长度不合规、常见及包含邮箱名称的弱密码", () => {
    expectAuthError(() => validatePassword("short"), "PASSWORD_TOO_SHORT");
    expectAuthError(
      () => validatePassword("password1234"),
      "WEAK_PASSWORD",
    );
    expectAuthError(
      () => validatePassword("alice-is-great-2026", "alice@example.com"),
      "WEAK_PASSWORD",
    );
    assert.equal(
      validatePassword("霜林!v7-Quartz-River"),
      "霜林!v7-Quartz-River",
    );
  });

  it("仓储强制规范化邮箱唯一且返回隔离副本", async () => {
    const repository = new InMemoryAuthRepository();
    const user = await repository.createUser({
      emailCanonical: "alice@example.com",
      passwordHash: "hash",
      status: "PENDING_EMAIL",
    });
    user.status = "BANNED";
    assert.equal(
      (await repository.findUserById(user.id))?.status,
      "PENDING_EMAIL",
    );
    await expectAuthRejection(
      () =>
        repository.createUser({
          emailCanonical: "alice@example.com",
          passwordHash: "another",
          status: "PENDING_EMAIL",
        }),
      "EMAIL_ALREADY_EXISTS",
    );
  });

  it("验证令牌只存摘要、有 TTL 且只能消费一次", async () => {
    const repository = new InMemoryAuthRepository();
    let now = new Date("2026-07-24T00:00:00.000Z");
    const service = new VerificationTokenService(repository, () => now);
    const issued = await service.issue(
      "user-1",
      "EMAIL_VERIFICATION",
      1_000,
    );
    assert.equal(
      (await repository.findVerificationTokenByHash(
        hashOpaqueToken(issued.token),
      ))?.tokenHash,
      hashOpaqueToken(issued.token),
    );
    assert.equal(
      await repository.findVerificationTokenByHash(issued.token),
      undefined,
    );
    assert.equal(
      (await service.consume(
        issued.token,
        "EMAIL_VERIFICATION",
        "user-1",
      )).subjectId,
      "user-1",
    );
    await expectAuthRejection(
      () => service.consume(issued.token, "EMAIL_VERIFICATION"),
      "TOKEN_CONSUMED",
    );

    const expired = await service.issue("user-1", "PASSWORD_RESET", 100);
    now = new Date(now.getTime() + 100);
    await expectAuthRejection(
      () => service.consume(expired.token, "PASSWORD_RESET"),
      "TOKEN_EXPIRED",
    );
  });

  it("会话执行空闲续期、绝对过期、轮换和全撤销", async () => {
    const repository = new InMemoryAuthRepository();
    let now = new Date("2026-07-24T00:00:00.000Z");
    const sessions = new SessionService(
      repository,
      { idleTtlMs: 1_000, absoluteTtlMs: 3_000 },
      () => now,
    );
    const first = await sessions.create("user-1");
    assert.equal(
      await repository.findSessionByHash(first.token),
      undefined,
    );
    assert.match(first.csrfToken, /^[A-Za-z0-9_-]+$/u);
    assert.match(first.session.csrfTokenHash, /^[a-f0-9]{64}$/u);

    now = new Date(now.getTime() + 500);
    assert.equal(
      (await sessions.authenticate(first.token)).idleExpiresAt.toISOString(),
      "2026-07-24T00:00:01.500Z",
    );
    const rotated = await sessions.rotate(first.token);
    assert.notEqual(rotated.csrfToken, first.csrfToken);
    assert.notEqual(
      rotated.session.csrfTokenHash,
      first.session.csrfTokenHash,
    );
    await expectAuthRejection(
      () => sessions.authenticate(first.token),
      "SESSION_REVOKED",
    );
    assert.equal(
      rotated.session.absoluteExpiresAt.toISOString(),
      "2026-07-24T00:00:03.000Z",
    );

    const second = await sessions.create("user-1");
    assert.equal(
      await sessions.revokeAll("user-1", second.session.id),
      1,
    );
    assert.equal(
      (await sessions.authenticate(second.token)).userId,
      "user-1",
    );

    now = new Date("2026-07-24T00:00:03.000Z");
    await expectAuthRejection(
      () => sessions.authenticate(second.token),
      "SESSION_EXPIRED",
    );
  });

  it("已撤销会话不能被陈旧更新恢复，且并发轮换只有一次成功", async () => {
    const repository = new InMemoryAuthRepository();
    let now = new Date("2026-07-24T00:00:00.000Z");
    const sessions = new SessionService(
      repository,
      { idleTtlMs: 60_000, absoluteTtlMs: 3_600_000 },
      () => now,
    );

    const revoked = await sessions.create("user-race");
    const stale = await repository.findSessionByHash(
      revoked.session.tokenHash,
    );
    assert.ok(stale);
    assert.equal(await sessions.revoke(revoked.token), true);
    now = new Date(now.getTime() + 1_000);
    stale.lastSeenAt = now;
    await repository.updateSession(stale);
    assert.equal(
      await repository.touchActiveSession(
        revoked.session.tokenHash,
        now,
        new Date(now.getTime() + 60_000),
      ),
      undefined,
    );
    await expectAuthRejection(
      () => sessions.authenticate(revoked.token),
      "SESSION_REVOKED",
    );

    const rotating = await sessions.create("user-race");
    const attempts = await Promise.allSettled([
      sessions.rotate(rotating.token),
      sessions.rotate(rotating.token),
    ]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    assert.ok(rejected);
    assert.equal((rejected.reason as AuthError).code, "SESSION_REVOKED");
    const replacement = attempts.find(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<SessionService["rotate"]>>
      > => attempt.status === "fulfilled",
    );
    assert.ok(replacement);
    assert.equal(
      (await sessions.authenticate(replacement.value.token)).userId,
      "user-race",
    );
  });

  it("设备令牌只存摘要并关联使用过的账号", async () => {
    const repository = new InMemoryAuthRepository();
    let now = new Date("2026-07-24T00:00:00.000Z");
    const devices = new DeviceService(repository, () => now);
    const issued = await devices.issue("user-1");
    assert.equal(
      await repository.findDeviceByHash(issued.token),
      undefined,
    );

    now = new Date(now.getTime() + 1_000);
    const recognized = await devices.recognize(issued.token, "user-2");
    assert.deepEqual(recognized.userIds, ["user-1", "user-2"]);
    assert.equal(
      recognized.lastSeenAt.toISOString(),
      "2026-07-24T00:00:01.000Z",
    );
    assert.equal(
      (await devices.setTrusted(issued.token, true)).trusted,
      true,
    );
    assert.equal(
      (await devices.setRiskScore(issued.token, 25)).riskScore,
      25,
    );
  });
});
