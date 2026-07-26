import { randomUUID } from "node:crypto";
import { canonicalizeEmail } from "./email.js";
import { AuthError } from "./errors.js";
import {
  validatePassword,
  type PasswordHasher,
} from "./password.js";
import type { AuthRepository } from "./repository.js";
import {
  SessionService,
  type IssuedSession,
  type SessionContext,
} from "./session-service.js";
import type {
  AccountStatus,
  AuthUser,
  DeviceRecord,
  SessionRecord,
  VerificationTokenPurpose,
} from "./types.js";
import { VerificationTokenService } from "./verification-token-service.js";

export interface EmailMessage {
  to: string;
  purpose: Extract<
    VerificationTokenPurpose,
    "EMAIL_VERIFICATION" | "PASSWORD_RESET"
  >;
  token: string;
  expiresAt: Date;
}

export interface EmailDelivery {
  send(message: EmailMessage): Promise<void>;
}

export type EmailDeliveryOperation =
  | "REGISTER_VERIFICATION"
  | "RESEND_VERIFICATION"
  | "PASSWORD_RESET";

export interface EmailDeliveryAttempt {
  purpose: EmailMessage["purpose"];
  operation: EmailDeliveryOperation;
  occurredAt: Date;
}

export interface EmailDeliveryFailureEvent extends EmailDeliveryAttempt {
  errorName: string;
}

export interface AuthServiceOptions {
  emailVerificationTtlMs: number;
  passwordResetTtlMs: number;
  onEmailDeliverySuccess: (event: EmailDeliveryAttempt) => void;
  onEmailDeliveryFailure: (event: EmailDeliveryFailureEvent) => void;
}

export type AccountCapability = "LOGIN" | "MATCH" | "ACCOUNT";

export interface PublicAuthResult {
  accepted: true;
  message: string;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  deviceId?: string;
  ipRiskKey?: string;
  userAgentSummary?: string;
  revokedAt?: Date;
}

export interface DeviceSummary {
  id: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  trusted: boolean;
  riskScore: number;
}

export interface AccountExportSummary {
  account: {
    id: string;
    email: string;
    playerNumber: number;
    displayName: string;
    status: AccountStatus;
    emailVerifiedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  };
  sessions: SessionSummary[];
  devices: DeviceSummary[];
}

const DEFAULT_OPTIONS: AuthServiceOptions = {
  emailVerificationTtlMs: 24 * 60 * 60 * 1_000,
  passwordResetTtlMs: 30 * 60 * 1_000,
  onEmailDeliverySuccess: () => {},
  onEmailDeliveryFailure: () => {},
};

const REGISTER_RESULT: PublicAuthResult = {
  accepted: true,
  message:
    "注册请求已提交。如果该邮箱可用于注册，你会收到验证邮件；请点击邮件中的激活链接后再返回登录。若暂未找到，请检查垃圾箱。",
};

const FORGOT_PASSWORD_RESULT: PublicAuthResult = {
  accepted: true,
  message: "如果该邮箱对应可用账号，我们会发送密码重置邮件。",
};

const RESEND_VERIFICATION_RESULT: PublicAuthResult = {
  accepted: true,
  message:
    "如果该邮箱仍在等待验证，我们会发送新的验证邮件；旧链接将失效。",
};

function normalizeOriginalEmail(input: unknown): string {
  if (typeof input !== "string") {
    throw new AuthError("INVALID_EMAIL", "邮箱必须是文本。");
  }
  return input.normalize("NFKC").trim();
}

function summarizeSession(session: SessionRecord): SessionSummary {
  return {
    id: session.id,
    createdAt: new Date(session.createdAt),
    lastSeenAt: new Date(session.lastSeenAt),
    idleExpiresAt: new Date(session.idleExpiresAt),
    absoluteExpiresAt: new Date(session.absoluteExpiresAt),
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    ...(session.ipRiskKey ? { ipRiskKey: session.ipRiskKey } : {}),
    ...(session.userAgentSummary
      ? { userAgentSummary: session.userAgentSummary }
      : {}),
    ...(session.revokedAt ? { revokedAt: new Date(session.revokedAt) } : {}),
  };
}

function summarizeDevice(device: DeviceRecord): DeviceSummary {
  return {
    id: device.id,
    firstSeenAt: new Date(device.firstSeenAt),
    lastSeenAt: new Date(device.lastSeenAt),
    trusted: device.trusted,
    riskScore: device.riskScore,
  };
}

export class AuthService {
  private readonly options: AuthServiceOptions;

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly verificationTokens: VerificationTokenService,
    private readonly sessions: SessionService,
    private readonly emailDelivery: EmailDelivery,
    options: Partial<AuthServiceOptions> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 无论邮箱是否已存在，成功校验输入后都返回同一公共结果。
   * 原始邮件令牌只交给邮件投递接口，不写日志、不写用户记录。
   */
  async register(email: unknown, password: unknown): Promise<PublicAuthResult> {
    const emailCanonical = canonicalizeEmail(email);
    const emailOriginal = normalizeOriginalEmail(email);
    const validPassword = validatePassword(password, emailCanonical);
    const passwordHash = await this.passwordHasher.hash(validPassword);
    if (await this.repository.findUserByCanonicalEmail(emailCanonical)) {
      return { ...REGISTER_RESULT };
    }

    let user: AuthUser;
    try {
      user = await this.repository.createUser(
        {
          emailOriginal,
          emailCanonical,
          passwordHash,
          status: "PENDING_EMAIL",
        },
        this.now(),
      );
    } catch (error) {
      // 并发注册由数据库唯一约束裁决，对外仍保持账号不可枚举的统一结果。
      if (error instanceof AuthError && error.code === "EMAIL_ALREADY_EXISTS") {
        return { ...REGISTER_RESULT };
      }
      throw error;
    }
    const issued = await this.verificationTokens.rotate(
      user.id,
      "EMAIL_VERIFICATION",
      this.options.emailVerificationTtlMs,
    );
    await this.deliverEmail(
      {
        to: user.emailOriginal,
        purpose: "EMAIL_VERIFICATION",
        token: issued.token,
        expiresAt: issued.expiresAt,
      },
      "REGISTER_VERIFICATION",
    );
    return { ...REGISTER_RESULT };
  }

  /**
   * 不论账户是否存在或是否仍待验证，都返回同一公共结果。
   * 只有 PENDING_EMAIL 账户会轮换 Token 并触发真实投递。
   */
  async resendVerification(email: unknown): Promise<PublicAuthResult> {
    let user: AuthUser | undefined;
    try {
      user = await this.repository.findUserByCanonicalEmail(
        canonicalizeEmail(email),
      );
    } catch {
      return { ...RESEND_VERIFICATION_RESULT };
    }
    if (user?.status === "PENDING_EMAIL") {
      const issued = await this.verificationTokens.rotate(
        user.id,
        "EMAIL_VERIFICATION",
        this.options.emailVerificationTtlMs,
      );
      await this.deliverEmail(
        {
          to: user.emailOriginal,
          purpose: "EMAIL_VERIFICATION",
          token: issued.token,
          expiresAt: issued.expiresAt,
        },
        "RESEND_VERIFICATION",
      );
    }
    return { ...RESEND_VERIFICATION_RESULT };
  }

  /**
   * 仅供受控启动脚本和部署命令调用，不暴露为公共 HTTP 接口。
   * 已存在账户会被激活、提升为 ROOT 并轮换密码与全部会话。
   */
  async upsertRootAccount(
    email: unknown,
    password: unknown,
  ): Promise<AuthUser> {
    const emailCanonical = canonicalizeEmail(email);
    const emailOriginal = normalizeOriginalEmail(email);
    const validPassword = validatePassword(password, emailCanonical);
    const passwordHash = await this.passwordHasher.hash(validPassword);
    const now = this.now();
    const existing =
      await this.repository.findUserByCanonicalEmail(emailCanonical);
    if (!existing) {
      return this.repository.createUser(
        {
          emailOriginal,
          emailCanonical,
          passwordHash,
          status: "ACTIVE",
          role: "ROOT",
          emailVerifiedAt: now,
        },
        now,
      );
    }
    existing.emailOriginal = emailOriginal;
    existing.emailCanonical = emailCanonical;
    existing.passwordHash = passwordHash;
    existing.status = "ACTIVE";
    existing.role = "ROOT";
    existing.emailVerifiedAt = now;
    existing.updatedAt = now;
    const updated = await this.repository.updateUser(existing);
    await this.sessions.revokeAll(updated.id);
    return updated;
  }

  async verifyEmail(token: string): Promise<AuthUser> {
    const consumed = await this.verificationTokens.consume(
      token,
      "EMAIL_VERIFICATION",
    );
    const user = await this.requireUser(consumed.subjectId);
    if (user.status !== "PENDING_EMAIL") {
      throw new AuthError("ACCOUNT_RESTRICTED", "账号状态不允许邮箱验证。");
    }
    const now = this.now();
    user.status = "ACTIVE";
    user.emailVerifiedAt = now;
    user.updatedAt = now;
    return this.repository.updateUser(user);
  }

  async login(
    email: unknown,
    password: unknown,
    context: SessionContext = {},
  ): Promise<IssuedSession> {
    if (typeof password !== "string") {
      throw this.invalidCredentials();
    }
    let user: AuthUser | undefined;
    try {
      user = await this.repository.findUserByCanonicalEmail(
        canonicalizeEmail(email),
      );
    } catch {
      await this.passwordHasher.hash(password);
      throw this.invalidCredentials();
    }

    const passwordValid = user
      ? await this.passwordHasher.verify(user.passwordHash, password)
      : (await this.passwordHasher.hash(password), false);
    if (
      !user ||
      !passwordValid ||
      (user.status !== "ACTIVE" && user.status !== "LIMITED")
    ) {
      throw this.invalidCredentials();
    }
    return this.sessions.create(user.id, context);
  }

  async forgotPassword(email: unknown): Promise<PublicAuthResult> {
    let user: AuthUser | undefined;
    try {
      user = await this.repository.findUserByCanonicalEmail(
        canonicalizeEmail(email),
      );
    } catch {
      return { ...FORGOT_PASSWORD_RESULT };
    }
    if (user && (user.status === "ACTIVE" || user.status === "LIMITED")) {
      const issued = await this.verificationTokens.rotate(
        user.id,
        "PASSWORD_RESET",
        this.options.passwordResetTtlMs,
      );
      await this.deliverEmail(
        {
          to: user.emailOriginal,
          purpose: "PASSWORD_RESET",
          token: issued.token,
          expiresAt: issued.expiresAt,
        },
        "PASSWORD_RESET",
      );
    }
    return { ...FORGOT_PASSWORD_RESULT };
  }

  async resetPassword(
    token: string,
    newPassword: unknown,
  ): Promise<AuthUser> {
    const consumed = await this.verificationTokens.consume(
      token,
      "PASSWORD_RESET",
    );
    const user = await this.requireUser(consumed.subjectId);
    this.assertStatus(user, "ACCOUNT");
    const password = validatePassword(newPassword, user.emailCanonical);
    user.passwordHash = await this.passwordHasher.hash(password);
    user.updatedAt = this.now();
    await this.repository.updateUser(user);
    await this.sessions.revokeAll(user.id);
    return user;
  }

  private async deliverEmail(
    message: EmailMessage,
    operation: EmailDeliveryOperation,
  ): Promise<void> {
    try {
      await this.emailDelivery.send(message);
    } catch (error) {
      // 公开接口继续返回统一结果；告警事件严禁携带邮箱、Token 或错误正文。
      try {
        this.options.onEmailDeliveryFailure({
          purpose: message.purpose,
          operation,
          errorName: error instanceof Error ? error.name : "UnknownError",
          occurredAt: this.now(),
        });
      } catch {
        // 告警适配器故障不能改变公共响应。
      }
      return;
    }
    try {
      this.options.onEmailDeliverySuccess({
        purpose: message.purpose,
        operation,
        occurredAt: this.now(),
      });
    } catch {
      // 成功回调故障不能被误报为 SMTP 失败，也不能改变公共响应。
    }
  }

  async changePassword(
    userId: string,
    currentPassword: unknown,
    newPassword: unknown,
    currentSessionId?: string,
  ): Promise<void> {
    const user = await this.requireUser(userId);
    this.assertStatus(user, "ACCOUNT");
    if (
      typeof currentPassword !== "string" ||
      !(await this.passwordHasher.verify(user.passwordHash, currentPassword))
    ) {
      throw this.invalidCredentials();
    }
    const password = validatePassword(newPassword, user.emailCanonical);
    user.passwordHash = await this.passwordHasher.hash(password);
    user.updatedAt = this.now();
    await this.repository.updateUser(user);
    await this.sessions.revokeAll(user.id, currentSessionId);
  }

  async assertAccountCapability(
    userId: string,
    capability: AccountCapability,
  ): Promise<AuthUser> {
    const user = await this.requireUser(userId);
    this.assertStatus(user, capability);
    return user;
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    await this.assertAccountCapability(userId, "ACCOUNT");
    return (await this.repository.listSessionsByUser(userId))
      .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime())
      .map(summarizeSession);
  }

  async revokeSession(
    userId: string,
    sessionId: string,
  ): Promise<boolean> {
    await this.assertAccountCapability(userId, "ACCOUNT");
    const session = (await this.repository.listSessionsByUser(userId)).find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) {
      throw new AuthError("SESSION_NOT_FOUND", "找不到该会话。");
    }
    if (session.revokedAt) return false;
    session.revokedAt = this.now();
    await this.repository.updateSession(session);
    return true;
  }

  async revokeOthers(
    userId: string,
    currentSessionId: string,
  ): Promise<number> {
    await this.assertAccountCapability(userId, "ACCOUNT");
    return this.sessions.revokeAll(userId, currentSessionId);
  }

  async deleteAccount(
    userId: string,
    currentPassword: unknown,
  ): Promise<void> {
    const user = await this.requireUser(userId);
    this.assertStatus(user, "ACCOUNT");
    if (
      typeof currentPassword !== "string" ||
      !(await this.passwordHasher.verify(user.passwordHash, currentPassword))
    ) {
      throw this.invalidCredentials();
    }
    const now = this.now();
    user.emailOriginal = `deleted-${user.id}@deleted.invalid`;
    user.emailCanonical = user.emailOriginal;
    user.passwordHash = `deleted:${randomUUID()}`;
    user.displayName = "已删除用户";
    user.nickname = "已删除用户";
    user.typingStatus = "";
    user.status = "DELETED";
    delete user.emailVerifiedAt;
    user.updatedAt = now;
    await this.repository.updateUser(user);
    await this.sessions.revokeAll(user.id);
  }

  async exportAccountSummary(
    userId: string,
  ): Promise<AccountExportSummary> {
    const user = await this.assertAccountCapability(userId, "ACCOUNT");
    return {
      account: {
        id: user.id,
        email: user.emailOriginal,
        playerNumber: user.playerNumber,
        displayName: user.displayName,
        status: user.status,
        ...(user.emailVerifiedAt
          ? { emailVerifiedAt: new Date(user.emailVerifiedAt) }
          : {}),
        createdAt: new Date(user.createdAt),
        updatedAt: new Date(user.updatedAt),
      },
      sessions: (await this.repository.listSessionsByUser(user.id)).map(
        summarizeSession,
      ),
      devices: (await this.repository.listDevicesByUser(user.id)).map(
        summarizeDevice,
      ),
    };
  }

  async getUser(userId: string): Promise<AuthUser> {
    return this.requireUser(userId);
  }

  async authenticateSession(token: string): Promise<SessionRecord> {
    const session = await this.sessions.authenticate(token);
    const user = await this.requireUser(session.userId);
    this.assertStatus(user, "ACCOUNT");
    return session;
  }

  async rotateSession(token: string): Promise<IssuedSession> {
    await this.authenticateSession(token);
    return this.sessions.rotate(token);
  }

  async revokeCurrentSession(token: string): Promise<boolean> {
    return this.sessions.revoke(token);
  }

  private async requireUser(userId: string): Promise<AuthUser> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new AuthError("ACCOUNT_NOT_FOUND", "账号不存在。");
    }
    return user;
  }

  private assertStatus(
    user: AuthUser,
    capability: AccountCapability,
  ): void {
    const allowed =
      capability === "MATCH"
        ? user.status === "ACTIVE"
        : user.status === "ACTIVE" || user.status === "LIMITED";
    if (!allowed) {
      throw new AuthError("ACCOUNT_RESTRICTED", "账号状态不允许执行该操作。");
    }
  }

  private invalidCredentials(): AuthError {
    return new AuthError(
      "INVALID_CREDENTIALS",
      "邮箱、密码或账号状态无效。",
    );
  }
}
