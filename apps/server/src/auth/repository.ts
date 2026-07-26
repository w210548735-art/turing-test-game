import { randomUUID } from "node:crypto";
import { AuthError } from "./errors.js";
import type {
  AuthUser,
  DeviceRecord,
  SessionRecord,
  VerificationTokenRecord,
} from "./types.js";

export type CreateUserInput = Omit<
  AuthUser,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "emailOriginal"
  | "playerNumber"
  | "displayName"
  | "nickname"
  | "typingStatus"
  | "role"
> & {
  emailOriginal?: string;
  displayName?: string;
  nickname?: string;
  typingStatus?: string;
  role?: AuthUser["role"];
};

export interface AdminDailyAccountMetric {
  date: string;
  registrations: number;
  visits: number;
}

export interface AdminAccountMetrics {
  registeredUsers: number;
  newUsersToday: number;
  newUsers7d: number;
  previous7dUsers: number;
  visitsToday: number;
  visits7d: number;
  previous7dVisits: number;
  verifiedUsers: number;
  pendingVerificationUsers: number;
  activeSessions: number;
  daily: AdminDailyAccountMetric[];
}

export type VerificationTokenConsumeResult =
  | {
      status: "CONSUMED";
      token: VerificationTokenRecord;
    }
  | {
      status: "INVALID" | "ALREADY_CONSUMED" | "EXPIRED";
    };

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function copyUser(user: AuthUser): AuthUser {
  return {
    ...user,
    createdAt: copyDate(user.createdAt),
    updatedAt: copyDate(user.updatedAt),
    ...(user.emailVerifiedAt
      ? { emailVerifiedAt: copyDate(user.emailVerifiedAt) }
      : {}),
  };
}

function copyToken(token: VerificationTokenRecord): VerificationTokenRecord {
  return {
    ...token,
    createdAt: copyDate(token.createdAt),
    expiresAt: copyDate(token.expiresAt),
    ...(token.consumedAt ? { consumedAt: copyDate(token.consumedAt) } : {}),
    ...(token.revokedAt ? { revokedAt: copyDate(token.revokedAt) } : {}),
  };
}

function copySession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    createdAt: copyDate(session.createdAt),
    lastSeenAt: copyDate(session.lastSeenAt),
    idleExpiresAt: copyDate(session.idleExpiresAt),
    absoluteExpiresAt: copyDate(session.absoluteExpiresAt),
    ...(session.revokedAt ? { revokedAt: copyDate(session.revokedAt) } : {}),
  };
}

function copyDevice(device: DeviceRecord): DeviceRecord {
  return {
    ...device,
    firstSeenAt: copyDate(device.firstSeenAt),
    lastSeenAt: copyDate(device.lastSeenAt),
    userIds: [...device.userIds],
  };
}

const CHINA_TIME_ZONE = "Asia/Shanghai";

function chinaDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHINA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  return `${valueByType.get("year")}-${valueByType.get("month")}-${valueByType.get("day")}`;
}

function offsetDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

export function buildAdminAccountMetrics(
  users: readonly AuthUser[],
  sessions: readonly SessionRecord[],
  now = new Date(),
): AdminAccountMetrics {
  const today = chinaDateKey(now);
  const dailyKeys = Array.from(
    { length: 7 },
    (_, index) => offsetDateKey(today, index - 6),
  );
  const currentKeys = new Set(dailyKeys);
  const previousKeys = new Set(
    Array.from({ length: 7 }, (_, index) => offsetDateKey(today, index - 13)),
  );
  const daily = new Map(
    dailyKeys.map((date) => [date, { date, registrations: 0, visits: 0 }]),
  );
  let newUsers7d = 0;
  let previous7dUsers = 0;
  let visits7d = 0;
  let previous7dVisits = 0;

  for (const user of users) {
    if (user.status === "DELETED") continue;
    const date = chinaDateKey(user.createdAt);
    if (currentKeys.has(date)) {
      newUsers7d += 1;
      const bucket = daily.get(date);
      if (bucket) bucket.registrations += 1;
    } else if (previousKeys.has(date)) {
      previous7dUsers += 1;
    }
  }
  for (const session of sessions) {
    const date = chinaDateKey(session.createdAt);
    if (currentKeys.has(date)) {
      visits7d += 1;
      const bucket = daily.get(date);
      if (bucket) bucket.visits += 1;
    } else if (previousKeys.has(date)) {
      previous7dVisits += 1;
    }
  }

  const todayMetric = daily.get(today);
  return {
    registeredUsers: users.filter((user) => user.status !== "DELETED").length,
    newUsersToday: todayMetric?.registrations ?? 0,
    newUsers7d,
    previous7dUsers,
    visitsToday: todayMetric?.visits ?? 0,
    visits7d,
    previous7dVisits,
    verifiedUsers: users.filter(
      (user) => user.status !== "DELETED" && user.emailVerifiedAt,
    ).length,
    pendingVerificationUsers: users.filter(
      (user) => user.status === "PENDING_EMAIL",
    ).length,
    activeSessions: sessions.filter(
      (session) =>
        !session.revokedAt &&
        session.idleExpiresAt.getTime() > now.getTime() &&
        session.absoluteExpiresAt.getTime() > now.getTime(),
    ).length,
    daily: dailyKeys.map((date) => daily.get(date)!),
  };
}

export interface AuthRepository {
  createUser(input: CreateUserInput, now?: Date): Promise<AuthUser>;
  findUserById(id: string): Promise<AuthUser | undefined>;
  findUserByCanonicalEmail(
    emailCanonical: string,
  ): Promise<AuthUser | undefined>;
  updateUser(user: AuthUser): Promise<AuthUser>;
  getAdminAccountMetrics(now?: Date): Promise<AdminAccountMetrics>;

  saveVerificationToken(token: VerificationTokenRecord): Promise<void>;
  findVerificationTokenByHash(
    tokenHash: string,
  ): Promise<VerificationTokenRecord | undefined>;
  updateVerificationToken(token: VerificationTokenRecord): Promise<void>;
  replaceVerificationToken(
    token: VerificationTokenRecord,
    revokedAt: Date,
  ): Promise<void>;
  consumeVerificationToken(
    tokenHash: string,
    purpose: VerificationTokenRecord["purpose"],
    consumedAt: Date,
    expectedSubjectId?: string,
  ): Promise<VerificationTokenConsumeResult>;

  saveSession(session: SessionRecord): Promise<void>;
  findSessionByHash(tokenHash: string): Promise<SessionRecord | undefined>;
  updateSession(session: SessionRecord): Promise<void>;
  touchActiveSession(
    tokenHash: string,
    lastSeenAt: Date,
    idleExpiresAt: Date,
  ): Promise<SessionRecord | undefined>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean>;
  revokeSessionsByUser(
    userId: string,
    revokedAt: Date,
    exceptSessionId?: string,
  ): Promise<number>;
  replaceActiveSession(
    tokenHash: string,
    replacement: SessionRecord,
    revokedAt: Date,
  ): Promise<boolean>;
  listSessionsByUser(userId: string): Promise<SessionRecord[]>;

  saveDevice(device: DeviceRecord): Promise<void>;
  findDeviceByHash(tokenHash: string): Promise<DeviceRecord | undefined>;
  updateDevice(device: DeviceRecord): Promise<void>;
  listDevicesByUser(userId: string): Promise<DeviceRecord[]>;
}

export class InMemoryAuthRepository implements AuthRepository {
  private nextPlayerNumber = 100_001;
  private readonly users = new Map<string, AuthUser>();
  private readonly userIdByEmail = new Map<string, string>();
  private readonly verificationTokens = new Map<
    string,
    VerificationTokenRecord
  >();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly devices = new Map<string, DeviceRecord>();

  async createUser(
    input: CreateUserInput,
    now = new Date(),
  ): Promise<AuthUser> {
    if (this.userIdByEmail.has(input.emailCanonical)) {
      throw new AuthError(
        "EMAIL_ALREADY_EXISTS",
        "无法使用该邮箱创建账号。",
      );
    }
    const user: AuthUser = {
      ...input,
      emailOriginal: input.emailOriginal ?? input.emailCanonical,
      playerNumber: this.nextPlayerNumber++,
      displayName: input.displayName ?? "图灵玩家",
      nickname: input.nickname ?? "新玩家",
      typingStatus: input.typingStatus ?? "",
      role: input.role ?? "PLAYER",
      id: randomUUID(),
      createdAt: copyDate(now),
      updatedAt: copyDate(now),
    };
    this.users.set(user.id, copyUser(user));
    this.userIdByEmail.set(user.emailCanonical, user.id);
    return copyUser(user);
  }

  async findUserById(id: string): Promise<AuthUser | undefined> {
    const user = this.users.get(id);
    return user ? copyUser(user) : undefined;
  }

  async findUserByCanonicalEmail(
    emailCanonical: string,
  ): Promise<AuthUser | undefined> {
    const id = this.userIdByEmail.get(emailCanonical);
    const user = id ? this.users.get(id) : undefined;
    return user ? copyUser(user) : undefined;
  }

  async updateUser(user: AuthUser): Promise<AuthUser> {
    const current = this.users.get(user.id);
    if (!current) {
      throw new Error("Auth user does not exist");
    }
    const owner = this.userIdByEmail.get(user.emailCanonical);
    if (owner && owner !== user.id) {
      throw new AuthError(
        "EMAIL_ALREADY_EXISTS",
        "无法使用该邮箱更新账号。",
      );
    }
    if (current.emailCanonical !== user.emailCanonical) {
      this.userIdByEmail.delete(current.emailCanonical);
      this.userIdByEmail.set(user.emailCanonical, user.id);
    }
    this.users.set(user.id, copyUser(user));
    return copyUser(user);
  }

  async getAdminAccountMetrics(
    now = new Date(),
  ): Promise<AdminAccountMetrics> {
    return buildAdminAccountMetrics(
      [...this.users.values()],
      [...this.sessions.values()],
      now,
    );
  }

  async saveVerificationToken(
    token: VerificationTokenRecord,
  ): Promise<void> {
    this.verificationTokens.set(token.tokenHash, copyToken(token));
  }

  async findVerificationTokenByHash(
    tokenHash: string,
  ): Promise<VerificationTokenRecord | undefined> {
    const token = this.verificationTokens.get(tokenHash);
    return token ? copyToken(token) : undefined;
  }

  async updateVerificationToken(
    token: VerificationTokenRecord,
  ): Promise<void> {
    if (!this.verificationTokens.has(token.tokenHash)) {
      throw new Error("Verification token does not exist");
    }
    this.verificationTokens.set(token.tokenHash, copyToken(token));
  }

  async replaceVerificationToken(
    token: VerificationTokenRecord,
    revokedAt: Date,
  ): Promise<void> {
    for (const [tokenHash, current] of this.verificationTokens) {
      if (
        current.subjectId !== token.subjectId ||
        current.purpose !== token.purpose ||
        current.consumedAt ||
        current.revokedAt
      ) {
        continue;
      }
      current.revokedAt = copyDate(revokedAt);
      this.verificationTokens.set(tokenHash, copyToken(current));
    }
    this.verificationTokens.set(token.tokenHash, copyToken(token));
  }

  async consumeVerificationToken(
    tokenHash: string,
    purpose: VerificationTokenRecord["purpose"],
    consumedAt: Date,
    expectedSubjectId?: string,
  ): Promise<VerificationTokenConsumeResult> {
    const token = this.verificationTokens.get(tokenHash);
    if (
      !token ||
      token.purpose !== purpose ||
      token.revokedAt ||
      (expectedSubjectId !== undefined &&
        token.subjectId !== expectedSubjectId)
    ) {
      return { status: "INVALID" };
    }
    if (token.consumedAt) {
      return { status: "ALREADY_CONSUMED" };
    }
    if (consumedAt.getTime() >= token.expiresAt.getTime()) {
      return { status: "EXPIRED" };
    }
    token.consumedAt = copyDate(consumedAt);
    this.verificationTokens.set(tokenHash, copyToken(token));
    return { status: "CONSUMED", token: copyToken(token) };
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, copySession(session));
  }

  async findSessionByHash(
    tokenHash: string,
  ): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(tokenHash);
    return session ? copySession(session) : undefined;
  }

  async updateSession(session: SessionRecord): Promise<void> {
    const current = this.sessions.get(session.tokenHash);
    if (!current) {
      throw new Error("Session does not exist");
    }
    this.sessions.set(
      session.tokenHash,
      copySession({
        ...session,
        // 普通资料更新不得把已经撤销的会话恢复成有效状态。
        ...(current.revokedAt ? { revokedAt: current.revokedAt } : {}),
      }),
    );
  }

  async touchActiveSession(
    tokenHash: string,
    lastSeenAt: Date,
    idleExpiresAt: Date,
  ): Promise<SessionRecord | undefined> {
    const current = this.sessions.get(tokenHash);
    if (
      !current ||
      current.revokedAt ||
      lastSeenAt.getTime() >= current.idleExpiresAt.getTime() ||
      lastSeenAt.getTime() >= current.absoluteExpiresAt.getTime()
    ) {
      return undefined;
    }
    current.lastSeenAt = copyDate(lastSeenAt);
    current.idleExpiresAt = copyDate(idleExpiresAt);
    this.sessions.set(tokenHash, copySession(current));
    return copySession(current);
  }

  async revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const current = this.sessions.get(tokenHash);
    if (!current || current.revokedAt) return false;
    current.revokedAt = copyDate(revokedAt);
    this.sessions.set(tokenHash, copySession(current));
    return true;
  }

  async revokeSessionsByUser(
    userId: string,
    revokedAt: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    let revoked = 0;
    for (const [tokenHash, session] of this.sessions) {
      if (
        session.userId !== userId ||
        session.revokedAt ||
        session.id === exceptSessionId
      ) {
        continue;
      }
      session.revokedAt = copyDate(revokedAt);
      this.sessions.set(tokenHash, copySession(session));
      revoked += 1;
    }
    return revoked;
  }

  async replaceActiveSession(
    tokenHash: string,
    replacement: SessionRecord,
    revokedAt: Date,
  ): Promise<boolean> {
    const current = this.sessions.get(tokenHash);
    if (
      !current ||
      current.revokedAt ||
      revokedAt.getTime() >= current.idleExpiresAt.getTime() ||
      revokedAt.getTime() >= current.absoluteExpiresAt.getTime()
    ) {
      return false;
    }
    current.revokedAt = copyDate(revokedAt);
    this.sessions.set(tokenHash, copySession(current));
    this.sessions.set(replacement.tokenHash, copySession(replacement));
    return true;
  }

  async listSessionsByUser(userId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map(copySession);
  }

  async saveDevice(device: DeviceRecord): Promise<void> {
    this.devices.set(device.tokenHash, copyDevice(device));
  }

  async findDeviceByHash(
    tokenHash: string,
  ): Promise<DeviceRecord | undefined> {
    const device = this.devices.get(tokenHash);
    return device ? copyDevice(device) : undefined;
  }

  async updateDevice(device: DeviceRecord): Promise<void> {
    if (!this.devices.has(device.tokenHash)) {
      throw new Error("Device does not exist");
    }
    this.devices.set(device.tokenHash, copyDevice(device));
  }

  async listDevicesByUser(userId: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()]
      .filter((device) => device.userIds.includes(userId))
      .map(copyDevice);
  }
}
