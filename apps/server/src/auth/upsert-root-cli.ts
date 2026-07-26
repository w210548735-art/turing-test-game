import { readFile } from "node:fs/promises";
import { createDatabase } from "../db/client.js";
import { PostgresAuthRepository } from "../db/repositories/auth-repository.js";
import { Argon2idPasswordHasher } from "./argon2id-password-hasher.js";
import { AuthService } from "./auth-service.js";
import { SessionService } from "./session-service.js";
import { VerificationTokenService } from "./verification-token-service.js";

async function main(): Promise<void> {
  const email = process.env.ROOT_ACCOUNT_EMAIL?.trim();
  const passwordFile = process.env.ROOT_ACCOUNT_PASSWORD_FILE?.trim();
  if (!email || !passwordFile) {
    throw new Error(
      "必须配置 ROOT_ACCOUNT_EMAIL 与 ROOT_ACCOUNT_PASSWORD_FILE。",
    );
  }
  const password = (await readFile(passwordFile, "utf8")).trim();
  const database = createDatabase();
  if (!database.available) {
    throw new Error("ROOT 账户更新需要 DATABASE_URL。");
  }
  try {
    const repository = new PostgresAuthRepository(database.db);
    const service = new AuthService(
      repository,
      new Argon2idPasswordHasher(),
      new VerificationTokenService(repository),
      new SessionService(repository),
      {
        async send() {
          throw new Error("ROOT 账户更新命令不允许投递邮件。");
        },
      },
    );
    const user = await service.upsertRootAccount(email, password);
    process.stdout.write(
      `${JSON.stringify({
        updated: true,
        email: user.emailCanonical,
        playerNumber: user.playerNumber,
        role: user.role,
        status: user.status,
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "ROOT 账户更新失败。";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
