import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type AppDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseAvailable {
  available: true;
  db: AppDatabase;
  close: () => Promise<void>;
}

export interface DatabaseUnavailable {
  available: false;
  reason: "DATABASE_URL_MISSING";
  message: string;
}

export type DatabaseState = DatabaseAvailable | DatabaseUnavailable;

export interface DatabaseOptions {
  databaseUrl?: string;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
}

/**
 * 创建数据库访问状态。
 *
 * 本地 Demo 可以不配置数据库，因此这里返回显式 unavailable 状态，
 * 避免应用在模块加载阶段因缺少环境变量而崩溃。
 */
export function createDatabase(
  options: DatabaseOptions = {},
): DatabaseState {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    return {
      available: false,
      reason: "DATABASE_URL_MISSING",
      message: "未配置 DATABASE_URL，持久化功能不可用。",
    };
  }

  const client = postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return {
    available: true,
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
