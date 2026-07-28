import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  InMemoryAuthRepository,
  type PasswordHasher,
} from "../src/auth/index.js";
import type { AppDatabase } from "../src/db/client.js";
import { FeedbackRepository } from "../src/db/repositories/feedback-repository.js";
import { feedback, users } from "../src/db/schema.js";
import * as schema from "../src/db/schema.js";
import { buildServer, type ServerContext } from "../src/server.js";

const TEST_ORIGIN = "http://localhost:5173";
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

class TestPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `test:${password}`;
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return passwordHash === `test:${password}`;
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
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

describe("反馈 HTTP 到 PostgreSQL 持久化", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let context: ServerContext;
  let userId: string;

  before(async () => {
    process.env.LOG_LEVEL = "silent";
    process.env.NODE_ENV = "development";
    process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
    client = new PGlite({ extensions: { pgcrypto } });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });

    const authRepository = new InMemoryAuthRepository();
    const created = await authRepository.createUser({
      emailCanonical: "feedback-postgres@example.com",
      passwordHash: "test:Feedback-Postgres-2026!",
      status: "ACTIVE",
      role: "PLAYER",
      emailVerifiedAt: new Date(),
    });
    userId = created.id;
    await database.insert(users).values({
      id: userId,
      emailOriginal: "feedback-postgres@example.com",
      emailCanonical: "feedback-postgres@example.com",
      passwordHash: "test:Feedback-Postgres-2026!",
      emailVerifiedAt: new Date(),
      playerNumber: 100_001,
      displayName: "反馈测试员",
      nickname: "反馈测试员",
      typingStatus: "正在记录问题…",
      status: "active",
      role: "player",
    });
    context = await buildServer({
      authRepository,
      passwordHasher: new TestPasswordHasher(),
      registrationOpen: false,
      feedbackRepository: new FeedbackRepository(
        database as unknown as AppDatabase,
      ),
    });
  });

  after(async () => {
    await context.app.close();
    await client.close();
  });

  it("提交成功后规范化并完整保存分类、标题和反馈正文", async () => {
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: {
        email: "feedback-postgres@example.com",
        password: "Feedback-Postgres-2026!",
      },
    });
    assert.equal(login.statusCode, 200);
    const body = login.json<{ csrfToken: string }>();
    const title = "聊天输入框在手机端无法输入";
    const details =
      "进入问题反馈页面后，详细描述输入框无法获得焦点，希望修复后仍能保留我已经填写的完整内容。";

    const submitted = await context.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: {
        origin: TEST_ORIGIN,
        cookie: cookieHeader(login.headers["set-cookie"]),
        "x-csrf-token": body.csrfToken,
      },
      payload: {
        category: "bug",
        title,
        details,
      },
    });
    assert.equal(submitted.statusCode, 202, submitted.body);

    const rows = await database
      .select()
      .from(feedback)
      .where(eq(feedback.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, "bug");
    assert.equal(rows[0]?.title, title);
    assert.equal(rows[0]?.details, details.normalize("NFKC"));
    assert.match(rows[0]?.details ?? "", /无法获得焦点/u);
    assert.match(rows[0]?.details ?? "", /保留我已经填写的完整内容/u);
    assert.equal(rows[0]?.deliveryStatus, "pending");
  });
});
