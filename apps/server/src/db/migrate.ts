import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("执行数据库迁移前必须配置 DATABASE_URL。");
}

const migrationsFolder =
  process.env.MIGRATIONS_DIR ??
  fileURLToPath(new URL("../../../drizzle", import.meta.url));
const client = postgres(databaseUrl, {
  max: 1,
  prepare: false,
});

try {
  const database = drizzle(client);
  await migrate(database, { migrationsFolder });
  process.stdout.write("数据库迁移完成。\n");
} finally {
  await client.end({ timeout: 5 });
}
