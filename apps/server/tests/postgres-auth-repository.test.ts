import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  AuthError,
  AuthService,
  DeviceService,
  SessionService,
  VerificationTokenService,
  type EmailDelivery,
  type PasswordHasher,
} from "../src/auth/index.js";
import type { AppDatabase } from "../src/db/client.js";
import { PostgresAuthRepository } from "../src/db/repositories/auth-repository.js";
import * as schema from "../src/db/schema.js";
import { SessionBoundCsrfService } from "../src/http-security/index.js";

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

function accountInput(emailCanonical: string) {
  return {
    emailOriginal: emailCanonical,
    emailCanonical,
    passwordHash: "argon2id-test-hash",
    status: "PENDING_EMAIL" as const,
  };
}

describe("PostgresAuthRepository PostgreSQL 语义", () => {
  let client: PGlite;
  let repository: PostgresAuthRepository;

  before(async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    const pgliteDatabase = drizzle(client, { schema });
    await migrate(pgliteDatabase, {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    // 生产 Repository 保持 AppDatabase；测试仅在边界窄化 PGlite 方言类型。
    repository = new PostgresAuthRepository(
      pgliteDatabase as unknown as AppDatabase,
    );
  });

  after(async () => {
    await client.close();
  });

  it("运行 0000–0004 后账户行无需伪造游客 Token，且并发邮箱唯一冲突被映射", async () => {
    const first = await repository.createUser(
      accountInput("first@example.com"),
    );
    assert.equal(first.nickname, "新玩家");
    assert.equal(first.typingStatus, "");

    const attempts = await Promise.allSettled([
      repository.createUser(accountInput("race@example.com")),
      repository.createUser(accountInput("race@example.com")),
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
    assert.equal(rejected.reason instanceof AuthError, true);
    assert.equal((rejected.reason as AuthError).code, "EMAIL_ALREADY_EXISTS");
  });

  it("验证 Token 在并发消费时只有一个请求成功", async () => {
    const user = await repository.createUser(
      accountInput("token@example.com"),
    );
    const tokens = new VerificationTokenService(repository);
    const issued = await tokens.issue(
      user.id,
      "EMAIL_VERIFICATION",
      60_000,
    );

    const attempts = await Promise.allSettled([
      tokens.consume(issued.token, "EMAIL_VERIFICATION", user.id),
      tokens.consume(issued.token, "EMAIL_VERIFICATION", user.id),
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
    assert.equal((rejected.reason as AuthError).code, "TOKEN_CONSUMED");
  });

  it("AuthService 并发注册遇到唯一冲突仍返回统一公共结果", async () => {
    const passwordHasher: PasswordHasher = {
      async hash(password) {
        return `test:${password}`;
      },
      async verify(passwordHash, password) {
        return passwordHash === `test:${password}`;
      },
    };
    const delivered: string[] = [];
    const emailDelivery: EmailDelivery = {
      async send(message) {
        delivered.push(message.to);
      },
    };
    const auth = new AuthService(
      repository,
      passwordHasher,
      new VerificationTokenService(repository),
      new SessionService(repository),
      emailDelivery,
    );

    const [first, second] = await Promise.all([
      auth.register("auth-race@example.com", "Quartz!River-2026"),
      auth.register("AUTH-RACE@example.com", "Nebula!Stone-2027"),
    ]);
    assert.deepEqual(second, first);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.toLowerCase(), "auth-race@example.com");
  });

  it("Session 持久化 CSRF 摘要并支持认证、轮换与撤销", async () => {
    const user = await repository.createUser(
      accountInput("session@example.com"),
    );
    let now = new Date("2026-07-24T00:00:00.000Z");
    const csrf = new SessionBoundCsrfService("x".repeat(32));
    const sessions = new SessionService(
      repository,
      { idleTtlMs: 60_000, absoluteTtlMs: 3_600_000 },
      () => now,
      csrf,
    );

    const first = await sessions.create(user.id);
    assert.equal(
      csrf.verify(
        first.session.id,
        first.csrfToken,
        first.session.csrfTokenHash,
      ),
      true,
    );
    now = new Date("2026-07-24T00:00:30.000Z");
    const authenticated = await sessions.authenticate(first.token);
    assert.equal(
      authenticated.idleExpiresAt.toISOString(),
      "2026-07-24T00:01:30.000Z",
    );

    const rotated = await sessions.rotate(first.token);
    assert.notEqual(rotated.csrfToken, first.csrfToken);
    assert.equal(
      csrf.verify(
        rotated.session.id,
        rotated.csrfToken,
        rotated.session.csrfTokenHash,
      ),
      true,
    );
    await assert.rejects(
      () => sessions.authenticate(first.token),
      (error: unknown) =>
        error instanceof AuthError && error.code === "SESSION_REVOKED",
    );
    assert.equal(await sessions.revoke(rotated.token), true);
    await assert.rejects(
      () => sessions.authenticate(rotated.token),
      (error: unknown) =>
        error instanceof AuthError && error.code === "SESSION_REVOKED",
    );
  });

  it("设备通过 device_accounts 正确持久化多个账号", async () => {
    const first = await repository.createUser(
      accountInput("device-one@example.com"),
    );
    const second = await repository.createUser(
      accountInput("device-two@example.com"),
    );
    const devices = new DeviceService(repository);
    const issued = await devices.issue(first.id);
    const recognized = await devices.recognize(issued.token, second.id);
    assert.deepEqual(
      new Set(recognized.userIds),
      new Set([first.id, second.id]),
    );

    const restored = await repository.findDeviceByHash(
      recognized.tokenHash,
    );
    assert.deepEqual(
      new Set(restored?.userIds),
      new Set([first.id, second.id]),
    );
    assert.equal((await repository.listDevicesByUser(first.id)).length, 1);
    assert.equal((await repository.listDevicesByUser(second.id)).length, 1);
  });
});
