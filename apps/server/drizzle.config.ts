import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // 仅供本地迁移命令使用；运行时缺少 DATABASE_URL 时不会连接数据库。
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/turing_game",
  },
  strict: true,
  verbose: true,
});
