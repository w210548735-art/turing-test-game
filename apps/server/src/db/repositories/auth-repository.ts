import {
  and,
  eq,
  gt,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { AuthError } from "../../auth/errors.js";
import {
  buildAdminAccountMetrics,
  type AuthRepository,
  type CreateUserInput,
  type VerificationTokenConsumeResult,
} from "../../auth/repository.js";
import type {
  AccountStatus,
  AuthUser,
  DeviceRecord,
  SessionRecord,
  VerificationTokenPurpose,
  VerificationTokenRecord,
} from "../../auth/types.js";
import type { AppDatabase } from "../client.js";
import {
  deviceAccounts,
  devices,
  sessions,
  users,
  verificationTokens,
  type DeviceRow,
  type SessionRow,
  type UserRow,
  type VerificationTokenRow,
} from "../schema.js";

const ACCOUNT_STATUS_TO_DATABASE = {
  PENDING_EMAIL: "pending_email",
  ACTIVE: "active",
  LIMITED: "limited",
  SUSPENDED: "suspended",
  BANNED: "banned",
  DELETED: "deleted",
} as const satisfies Record<AccountStatus, UserRow["status"]>;

const DATABASE_STATUS_TO_ACCOUNT = {
  pending_email: "PENDING_EMAIL",
  active: "ACTIVE",
  limited: "LIMITED",
  suspended: "SUSPENDED",
  banned: "BANNED",
  deleted: "DELETED",
} as const satisfies Record<UserRow["status"], AccountStatus>;

const TOKEN_PURPOSE_TO_DATABASE = {
  EMAIL_VERIFICATION: "verify_email",
  PASSWORD_RESET: "reset_password",
  EMAIL_CHANGE: "change_email",
  WEBSOCKET_TICKET: "websocket_ticket",
} as const satisfies Record<
  VerificationTokenPurpose,
  VerificationTokenRow["purpose"]
>;

const DATABASE_PURPOSE_TO_TOKEN = {
  verify_email: "EMAIL_VERIFICATION",
  reset_password: "PASSWORD_RESET",
  change_email: "EMAIL_CHANGE",
  websocket_ticket: "WEBSOCKET_TICKET",
} as const satisfies Record<
  VerificationTokenRow["purpose"],
  VerificationTokenPurpose
>;

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function mapUser(row: UserRow): AuthUser | undefined {
  if (
    !row.emailOriginal ||
    !row.emailCanonical ||
    !row.passwordHash ||
    row.playerNumber === null ||
    !row.displayName
  ) {
    return undefined;
  }
  return {
    id: row.id,
    emailOriginal: row.emailOriginal,
    emailCanonical: row.emailCanonical,
    passwordHash: row.passwordHash,
    playerNumber: row.playerNumber,
    displayName: row.displayName,
    nickname: row.nickname,
    typingStatus: row.typingStatus,
    status: DATABASE_STATUS_TO_ACCOUNT[row.status],
    role: row.role === "root" ? "ROOT" : "PLAYER",
    ...(row.emailVerifiedAt
      ? { emailVerifiedAt: cloneDate(row.emailVerifiedAt) }
      : {}),
    createdAt: cloneDate(row.createdAt),
    updatedAt: cloneDate(row.updatedAt),
  };
}

function mapVerificationToken(
  row: VerificationTokenRow,
): VerificationTokenRecord {
  return {
    id: row.id,
    subjectId: row.userId,
    purpose: DATABASE_PURPOSE_TO_TOKEN[row.purpose],
    tokenHash: row.tokenHash,
    createdAt: cloneDate(row.createdAt),
    expiresAt: cloneDate(row.expiresAt),
    ...(row.usedAt ? { consumedAt: cloneDate(row.usedAt) } : {}),
    ...(row.revokedAt ? { revokedAt: cloneDate(row.revokedAt) } : {}),
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    csrfTokenHash: row.csrfTokenHash,
    createdAt: cloneDate(row.createdAt),
    lastSeenAt: cloneDate(row.lastSeenAt),
    idleExpiresAt: cloneDate(row.idleExpiresAt),
    absoluteExpiresAt: cloneDate(row.absoluteExpiresAt),
    ...(row.deviceId ? { deviceId: row.deviceId } : {}),
    ...(row.ipHash ? { ipRiskKey: row.ipHash } : {}),
    ...(row.userAgentHash ? { userAgentSummary: row.userAgentHash } : {}),
    ...(row.revokedAt ? { revokedAt: cloneDate(row.revokedAt) } : {}),
  };
}

function mapDevice(row: DeviceRow, userIds: string[]): DeviceRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    firstSeenAt: cloneDate(row.createdAt),
    lastSeenAt: cloneDate(row.lastSeenAt),
    trusted: row.trustedAt !== null,
    riskScore: row.riskScore,
    userIds: [...userIds],
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    candidate.code === "23505" ||
    (candidate.cause !== undefined && isUniqueViolation(candidate.cause))
  );
}

/**
 * 账户认证的 PostgreSQL Repository。
 *
 * 所有原始 Session、CSRF、设备和验证 Token 都由上层摘要后再传入；
 * 本 Repository 只持久化摘要。
 */
export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly database: AppDatabase) {}

  async createUser(
    input: CreateUserInput,
    now = new Date(),
  ): Promise<AuthUser> {
    try {
      const [row] = await this.database
        .insert(users)
        .values({
          sessionTokenHash: null,
          emailOriginal: input.emailOriginal ?? input.emailCanonical,
          emailCanonical: input.emailCanonical,
          passwordHash: input.passwordHash,
          playerNumber: sql<number>`nextval('user_player_number_seq')`,
          displayName: input.displayName ?? "图灵玩家",
          nickname: input.nickname ?? "新玩家",
          typingStatus: input.typingStatus ?? "",
          status: ACCOUNT_STATUS_TO_DATABASE[input.status],
          role: input.role === "ROOT" ? "root" : "player",
          emailVerifiedAt: input.emailVerifiedAt,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        })
        .returning();
      const user = row ? mapUser(row) : undefined;
      if (!user) {
        throw new Error("创建账户后未返回完整账户行");
      }
      return user;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthError(
          "EMAIL_ALREADY_EXISTS",
          "无法使用该邮箱创建账号。",
        );
      }
      throw error;
    }
  }

  async findUserById(id: string): Promise<AuthUser | undefined> {
    const [row] = await this.database
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ? mapUser(row) : undefined;
  }

  async findUserByCanonicalEmail(
    emailCanonical: string,
  ): Promise<AuthUser | undefined> {
    const [row] = await this.database
      .select()
      .from(users)
      .where(eq(users.emailCanonical, emailCanonical))
      .limit(1);
    return row ? mapUser(row) : undefined;
  }

  async updateUser(user: AuthUser): Promise<AuthUser> {
    try {
      const [row] = await this.database
        .update(users)
        .set({
          emailOriginal: user.emailOriginal,
          emailCanonical: user.emailCanonical,
          passwordHash: user.passwordHash,
          displayName: user.displayName,
          nickname: user.nickname,
          typingStatus: user.typingStatus,
          status: ACCOUNT_STATUS_TO_DATABASE[user.status],
          role: user.role === "ROOT" ? "root" : "player",
          emailVerifiedAt: user.emailVerifiedAt ?? null,
          deletedAt: user.status === "DELETED" ? user.updatedAt : null,
          updatedAt: user.updatedAt,
        })
        .where(eq(users.id, user.id))
        .returning();
      const updated = row ? mapUser(row) : undefined;
      if (!updated) {
        throw new Error("Auth user does not exist");
      }
      return updated;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthError(
          "EMAIL_ALREADY_EXISTS",
          "无法使用该邮箱更新账号。",
        );
      }
      throw error;
    }
  }

  async getAdminAccountMetrics(now = new Date()) {
    const [userRows, sessionRows] = await Promise.all([
      this.database.select().from(users),
      this.database.select().from(sessions),
    ]);
    return buildAdminAccountMetrics(
      userRows.flatMap((row) => {
        const user = mapUser(row);
        return user ? [user] : [];
      }),
      sessionRows.map(mapSession),
      now,
    );
  }

  async saveVerificationToken(
    token: VerificationTokenRecord,
  ): Promise<void> {
    await this.database.insert(verificationTokens).values({
      id: token.id,
      userId: token.subjectId,
      purpose: TOKEN_PURPOSE_TO_DATABASE[token.purpose],
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      usedAt: token.consumedAt,
      revokedAt: token.revokedAt,
      createdAt: token.createdAt,
    });
  }

  async findVerificationTokenByHash(
    tokenHash: string,
  ): Promise<VerificationTokenRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.tokenHash, tokenHash))
      .limit(1);
    return row ? mapVerificationToken(row) : undefined;
  }

  async updateVerificationToken(
    token: VerificationTokenRecord,
  ): Promise<void> {
    const rows = await this.database
      .update(verificationTokens)
      .set({
        usedAt: token.consumedAt ?? null,
        // 普通状态更新不得把已撤销的验证令牌恢复为有效。
        ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
      })
      .where(eq(verificationTokens.tokenHash, token.tokenHash))
      .returning({ id: verificationTokens.id });
    if (rows.length === 0) {
      throw new Error("Verification token does not exist");
    }
  }

  async replaceVerificationToken(
    token: VerificationTokenRecord,
    revokedAt: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // 同一账户的并发重发必须串行化，避免两个事务各自留下有效新 Token。
      await transaction.execute(sql`
        SELECT ${users.id}
        FROM ${users}
        WHERE ${users.id} = ${token.subjectId}
        FOR UPDATE
      `);
      await transaction
        .update(verificationTokens)
        .set({ revokedAt })
        .where(
          and(
            eq(verificationTokens.userId, token.subjectId),
            eq(
              verificationTokens.purpose,
              TOKEN_PURPOSE_TO_DATABASE[token.purpose],
            ),
            isNull(verificationTokens.usedAt),
            isNull(verificationTokens.revokedAt),
          ),
        );
      await transaction.insert(verificationTokens).values({
        id: token.id,
        userId: token.subjectId,
        purpose: TOKEN_PURPOSE_TO_DATABASE[token.purpose],
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
        usedAt: token.consumedAt,
        revokedAt: token.revokedAt,
        createdAt: token.createdAt,
      });
    });
  }

  async consumeVerificationToken(
    tokenHash: string,
    purpose: VerificationTokenPurpose,
    consumedAt: Date,
    expectedSubjectId?: string,
  ): Promise<VerificationTokenConsumeResult> {
    const conditions = [
      eq(verificationTokens.tokenHash, tokenHash),
      eq(verificationTokens.purpose, TOKEN_PURPOSE_TO_DATABASE[purpose]),
      isNull(verificationTokens.usedAt),
      isNull(verificationTokens.revokedAt),
      gt(verificationTokens.expiresAt, consumedAt),
    ];
    if (expectedSubjectId !== undefined) {
      conditions.push(eq(verificationTokens.userId, expectedSubjectId));
    }

    const [consumed] = await this.database
      .update(verificationTokens)
      .set({ usedAt: consumedAt })
      .where(and(...conditions))
      .returning();
    if (consumed) {
      return {
        status: "CONSUMED",
        token: mapVerificationToken(consumed),
      };
    }

    const [current] = await this.database
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.tokenHash, tokenHash))
      .limit(1);
    if (
      !current ||
      current.purpose !== TOKEN_PURPOSE_TO_DATABASE[purpose] ||
      current.revokedAt ||
      (expectedSubjectId !== undefined &&
        current.userId !== expectedSubjectId)
    ) {
      return { status: "INVALID" };
    }
    if (current.usedAt) {
      return { status: "ALREADY_CONSUMED" };
    }
    if (consumedAt.getTime() >= current.expiresAt.getTime()) {
      return { status: "EXPIRED" };
    }
    // 仅可能由同一 Token 的并发消费导致；再次读取后按已消费处理。
    return { status: "ALREADY_CONSUMED" };
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.database.insert(sessions).values({
      id: session.id,
      userId: session.userId,
      deviceId: session.deviceId,
      tokenHash: session.tokenHash,
      csrfTokenHash: session.csrfTokenHash,
      ipHash: session.ipRiskKey,
      userAgentHash: session.userAgentSummary,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      revokedAt: session.revokedAt,
    });
  }

  async findSessionByHash(
    tokenHash: string,
  ): Promise<SessionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    return row ? mapSession(row) : undefined;
  }

  async updateSession(session: SessionRecord): Promise<void> {
    const rows = await this.database
      .update(sessions)
      .set({
        csrfTokenHash: session.csrfTokenHash,
        deviceId: session.deviceId ?? null,
        ipHash: session.ipRiskKey ?? null,
        userAgentHash: session.userAgentSummary ?? null,
        lastSeenAt: session.lastSeenAt,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        // 不允许常规会话资料更新把数据库中已撤销的状态覆盖回 null。
        ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
      })
      .where(eq(sessions.tokenHash, session.tokenHash))
      .returning({ id: sessions.id });
    if (rows.length === 0) {
      throw new Error("Session does not exist");
    }
  }

  async touchActiveSession(
    tokenHash: string,
    lastSeenAt: Date,
    idleExpiresAt: Date,
  ): Promise<SessionRecord | undefined> {
    const [row] = await this.database
      .update(sessions)
      .set({ lastSeenAt, idleExpiresAt })
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.idleExpiresAt, lastSeenAt),
          gt(sessions.absoluteExpiresAt, lastSeenAt),
        ),
      )
      .returning();
    return row ? mapSession(row) : undefined;
  }

  async revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const rows = await this.database
      .update(sessions)
      .set({ revokedAt })
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length === 1;
  }

  async revokeSessionsByUser(
    userId: string,
    revokedAt: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    const rows = await this.database
      .update(sessions)
      .set({ revokedAt })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId
            ? ne(sessions.id, exceptSessionId)
            : undefined,
        ),
      )
      .returning({ id: sessions.id });
    return rows.length;
  }

  async replaceActiveSession(
    tokenHash: string,
    replacement: SessionRecord,
    revokedAt: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(sessions)
        .set({ revokedAt })
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, revokedAt),
            gt(sessions.absoluteExpiresAt, revokedAt),
          ),
        )
        .returning({ id: sessions.id });
      if (rows.length === 0) return false;

      await transaction.insert(sessions).values({
        id: replacement.id,
        userId: replacement.userId,
        deviceId: replacement.deviceId,
        tokenHash: replacement.tokenHash,
        csrfTokenHash: replacement.csrfTokenHash,
        ipHash: replacement.ipRiskKey,
        userAgentHash: replacement.userAgentSummary,
        createdAt: replacement.createdAt,
        lastSeenAt: replacement.lastSeenAt,
        idleExpiresAt: replacement.idleExpiresAt,
        absoluteExpiresAt: replacement.absoluteExpiresAt,
        revokedAt: replacement.revokedAt,
      });
      return true;
    });
  }

  async listSessionsByUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.database
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId));
    return rows.map(mapSession);
  }

  async saveDevice(device: DeviceRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(devices).values({
        id: device.id,
        tokenHash: device.tokenHash,
        trustedAt: device.trusted ? device.lastSeenAt : null,
        riskScore: device.riskScore,
        createdAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt,
      });
      if (device.userIds.length > 0) {
        await transaction.insert(deviceAccounts).values(
          device.userIds.map((userId) => ({
            deviceId: device.id,
            userId,
            linkedAt: device.firstSeenAt,
          })),
        );
      }
    });
  }

  async findDeviceByHash(
    tokenHash: string,
  ): Promise<DeviceRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, tokenHash))
      .limit(1);
    if (!row) return undefined;
    return mapDevice(row, await this.findDeviceUserIds(row.id));
  }

  async updateDevice(device: DeviceRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(devices)
        .set({
          trustedAt: device.trusted ? device.lastSeenAt : null,
          riskScore: device.riskScore,
          lastSeenAt: device.lastSeenAt,
        })
        .where(eq(devices.tokenHash, device.tokenHash))
        .returning({ id: devices.id });
      if (rows.length === 0) {
        throw new Error("Device does not exist");
      }
      if (device.userIds.length > 0) {
        await transaction
          .delete(deviceAccounts)
          .where(
            and(
              eq(deviceAccounts.deviceId, device.id),
              notInArray(deviceAccounts.userId, device.userIds),
            ),
          );
        await transaction.insert(deviceAccounts).values(
          device.userIds.map((userId) => ({
            deviceId: device.id,
            userId,
            linkedAt: device.lastSeenAt,
          })),
        ).onConflictDoNothing();
      } else {
        await transaction
          .delete(deviceAccounts)
          .where(eq(deviceAccounts.deviceId, device.id));
      }
    });
  }

  async listDevicesByUser(userId: string): Promise<DeviceRecord[]> {
    const rows = await this.database
      .select({ device: devices })
      .from(devices)
      .innerJoin(
        deviceAccounts,
        eq(deviceAccounts.deviceId, devices.id),
      )
      .where(eq(deviceAccounts.userId, userId));
    return Promise.all(
      rows.map(async ({ device }) =>
        mapDevice(device, await this.findDeviceUserIds(device.id)),
      ),
    );
  }

  private async findDeviceUserIds(deviceId: string): Promise<string[]> {
    const rows = await this.database
      .select({ userId: deviceAccounts.userId })
      .from(deviceAccounts)
      .where(eq(deviceAccounts.deviceId, deviceId));
    return rows.map(({ userId }) => userId);
  }
}
