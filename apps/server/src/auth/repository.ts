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
  | "nickname"
  | "typingStatus"
> & {
  emailOriginal?: string;
  nickname?: string;
  typingStatus?: string;
};

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

export interface AuthRepository {
  createUser(input: CreateUserInput, now?: Date): Promise<AuthUser>;
  findUserById(id: string): Promise<AuthUser | undefined>;
  findUserByCanonicalEmail(
    emailCanonical: string,
  ): Promise<AuthUser | undefined>;
  updateUser(user: AuthUser): Promise<AuthUser>;

  saveVerificationToken(token: VerificationTokenRecord): Promise<void>;
  findVerificationTokenByHash(
    tokenHash: string,
  ): Promise<VerificationTokenRecord | undefined>;
  updateVerificationToken(token: VerificationTokenRecord): Promise<void>;
  consumeVerificationToken(
    tokenHash: string,
    purpose: VerificationTokenRecord["purpose"],
    consumedAt: Date,
    expectedSubjectId?: string,
  ): Promise<VerificationTokenConsumeResult>;

  saveSession(session: SessionRecord): Promise<void>;
  findSessionByHash(tokenHash: string): Promise<SessionRecord | undefined>;
  updateSession(session: SessionRecord): Promise<void>;
  listSessionsByUser(userId: string): Promise<SessionRecord[]>;

  saveDevice(device: DeviceRecord): Promise<void>;
  findDeviceByHash(tokenHash: string): Promise<DeviceRecord | undefined>;
  updateDevice(device: DeviceRecord): Promise<void>;
  listDevicesByUser(userId: string): Promise<DeviceRecord[]>;
}

export class InMemoryAuthRepository implements AuthRepository {
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
      nickname: input.nickname ?? "新玩家",
      typingStatus: input.typingStatus ?? "",
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
    if (!this.sessions.has(session.tokenHash)) {
      throw new Error("Session does not exist");
    }
    this.sessions.set(session.tokenHash, copySession(session));
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
