import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken } from "./crypto.js";
import { AuthError } from "./errors.js";
import type { AuthRepository } from "./repository.js";
import type { SessionRecord } from "./types.js";

export interface SessionPolicy {
  idleTtlMs: number;
  absoluteTtlMs: number;
}

export const DEFAULT_ACCOUNT_SESSION_POLICY: Readonly<SessionPolicy> =
  Object.freeze({
    idleTtlMs: 2 * 60 * 60_000,
    absoluteTtlMs: 7 * 24 * 60 * 60_000,
  });

export interface IssuedSession {
  token: string;
  csrfToken: string;
  session: SessionRecord;
}

export interface IssuedSessionCsrfToken {
  token: string;
  hash: string;
}

/**
 * 与 SessionBoundCsrfService 的 issue 方法保持结构兼容。
 * 生产环境应注入共享密钥保护器；默认实现为每个服务实例生成随机密钥。
 */
export interface SessionCsrfProtector {
  issue(sessionId: string, now?: Date): IssuedSessionCsrfToken;
}

export interface SessionContext {
  deviceId?: string;
  ipRiskKey?: string;
  userAgentSummary?: string;
}

function validatePolicy(policy: SessionPolicy): void {
  if (
    !Number.isSafeInteger(policy.idleTtlMs) ||
    !Number.isSafeInteger(policy.absoluteTtlMs) ||
    policy.idleTtlMs <= 0 ||
    policy.absoluteTtlMs <= 0 ||
    policy.idleTtlMs > policy.absoluteTtlMs
  ) {
    throw new AuthError(
      "INVALID_SESSION_TTL",
      "会话空闲期限必须为正整数且不能超过绝对期限。",
    );
  }
}

class DefaultSessionCsrfProtector implements SessionCsrfProtector {
  private readonly secret = randomBytes(32);

  issue(sessionId: string): IssuedSessionCsrfToken {
    const token = randomBytes(32).toString("base64url");
    const hash = createHmac("sha256", this.secret)
      .update("csrf:v1\0", "utf8")
      .update(sessionId, "utf8")
      .update("\0", "utf8")
      .update(token, "utf8")
      .digest("hex");
    return { token, hash };
  }
}

export class SessionService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly policy: SessionPolicy = DEFAULT_ACCOUNT_SESSION_POLICY,
    private readonly now: () => Date = () => new Date(),
    private readonly csrfProtector: SessionCsrfProtector =
      new DefaultSessionCsrfProtector(),
  ) {
    validatePolicy(policy);
  }

  async create(
    userId: string,
    context: SessionContext = {},
  ): Promise<IssuedSession> {
    const now = this.now();
    return this.issue(
      userId,
      now,
      new Date(now.getTime() + this.policy.absoluteTtlMs),
      context,
    );
  }

  async authenticate(token: string): Promise<SessionRecord> {
    const record = await this.repository.findSessionByHash(
      hashOpaqueToken(token),
    );
    if (!record) {
      throw new AuthError("SESSION_INVALID", "会话无效。");
    }
    if (record.revokedAt) {
      throw new AuthError("SESSION_REVOKED", "会话已撤销。");
    }
    const now = this.now();
    if (
      now.getTime() >= record.idleExpiresAt.getTime() ||
      now.getTime() >= record.absoluteExpiresAt.getTime()
    ) {
      record.revokedAt = now;
      await this.repository.updateSession(record);
      throw new AuthError("SESSION_EXPIRED", "会话已过期。");
    }

    record.lastSeenAt = now;
    record.idleExpiresAt = new Date(
      Math.min(
        now.getTime() + this.policy.idleTtlMs,
        record.absoluteExpiresAt.getTime(),
      ),
    );
    await this.repository.updateSession(record);
    return record;
  }

  async revoke(token: string): Promise<boolean> {
    const record = await this.repository.findSessionByHash(
      hashOpaqueToken(token),
    );
    if (!record || record.revokedAt) return false;
    record.revokedAt = this.now();
    await this.repository.updateSession(record);
    return true;
  }

  async revokeAll(
    userId: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const now = this.now();
    let revoked = 0;
    for (const session of await this.repository.listSessionsByUser(userId)) {
      if (session.revokedAt || session.id === exceptSessionId) continue;
      session.revokedAt = now;
      await this.repository.updateSession(session);
      revoked += 1;
    }
    return revoked;
  }

  async rotate(token: string): Promise<IssuedSession> {
    const current = await this.authenticate(token);
    current.revokedAt = this.now();
    await this.repository.updateSession(current);
    return this.issue(
      current.userId,
      current.createdAt,
      current.absoluteExpiresAt,
      {
        ...(current.deviceId ? { deviceId: current.deviceId } : {}),
        ...(current.ipRiskKey ? { ipRiskKey: current.ipRiskKey } : {}),
        ...(current.userAgentSummary
          ? { userAgentSummary: current.userAgentSummary }
          : {}),
      },
    );
  }

  private async issue(
    userId: string,
    createdAt: Date,
    absoluteExpiresAt: Date,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const token = createOpaqueToken();
    const now = this.now();
    const sessionId = randomUUID();
    const csrf = this.csrfProtector.issue(sessionId, now);
    const session: SessionRecord = {
      id: sessionId,
      userId,
      tokenHash: hashOpaqueToken(token),
      csrfTokenHash: csrf.hash,
      createdAt: new Date(createdAt),
      lastSeenAt: now,
      idleExpiresAt: new Date(
        Math.min(
          now.getTime() + this.policy.idleTtlMs,
          absoluteExpiresAt.getTime(),
        ),
      ),
      absoluteExpiresAt: new Date(absoluteExpiresAt),
      ...(context.deviceId
        ? { deviceId: context.deviceId.slice(0, 128) }
        : {}),
      ...(context.ipRiskKey
        ? { ipRiskKey: context.ipRiskKey.slice(0, 128) }
        : {}),
      ...(context.userAgentSummary
        ? { userAgentSummary: context.userAgentSummary.slice(0, 200) }
        : {}),
    };
    await this.repository.saveSession(session);
    return { token, csrfToken: csrf.token, session };
  }
}
