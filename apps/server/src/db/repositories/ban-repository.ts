import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { AppDatabase } from "../client.js";
import {
  bans,
  type BanRow,
  type NewBanRow,
} from "../schema.js";

function requiredRow<T>(row: T | undefined, operation: string): T {
  if (!row) {
    throw new Error(`数据库操作未返回记录：${operation}`);
  }
  return row;
}

export class BanRepository {
  constructor(private readonly db: AppDatabase) {}

  async create(input: NewBanRow): Promise<BanRow> {
    const [row] = await this.db
      .insert(bans)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const existing = await this.findActive(
      input.scope,
      input.identityHash,
    );
    return requiredRow(existing ?? undefined, "createBan 幂等读取");
  }

  async findActive(
    scope: "user" | "session" | "device" | "ip",
    identityHash: string,
    now = new Date(),
  ): Promise<BanRow | null> {
    const [row] = await this.db
      .select()
      .from(bans)
      .where(
        and(
          eq(bans.scope, scope),
          eq(bans.identityHash, identityHash),
          isNull(bans.revokedAt),
          or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
        ),
      )
      .orderBy(desc(bans.createdAt))
      .limit(1);
    return row ?? null;
  }

  async revoke(
    banId: string,
    revokedBy: string,
    revokedAt = new Date(),
  ): Promise<BanRow | null> {
    const [row] = await this.db
      .update(bans)
      .set({ revokedAt, revokedBy })
      .where(and(eq(bans.id, banId), isNull(bans.revokedAt)))
      .returning();
    return row ?? null;
  }
}
