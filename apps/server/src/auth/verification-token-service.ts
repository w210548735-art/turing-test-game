import { randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken } from "./crypto.js";
import { AuthError } from "./errors.js";
import type { AuthRepository } from "./repository.js";
import type {
  VerificationTokenPurpose,
  VerificationTokenRecord,
} from "./types.js";

export interface IssuedVerificationToken {
  token: string;
  expiresAt: Date;
}

export class VerificationTokenService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(
    subjectId: string,
    purpose: VerificationTokenPurpose,
    ttlMs: number,
  ): Promise<IssuedVerificationToken> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new AuthError("INVALID_TOKEN_TTL", "令牌有效期必须为正整数。");
    }
    const token = createOpaqueToken();
    const createdAt = this.now();
    const record: VerificationTokenRecord = {
      id: randomUUID(),
      subjectId,
      purpose,
      tokenHash: hashOpaqueToken(token),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + ttlMs),
    };
    await this.repository.saveVerificationToken(record);
    return { token, expiresAt: new Date(record.expiresAt) };
  }

  async consume(
    token: string,
    purpose: VerificationTokenPurpose,
    expectedSubjectId?: string,
  ): Promise<VerificationTokenRecord> {
    const result = await this.repository.consumeVerificationToken(
      hashOpaqueToken(token),
      purpose,
      this.now(),
      expectedSubjectId,
    );
    switch (result.status) {
      case "CONSUMED":
        return result.token;
      case "ALREADY_CONSUMED":
        throw new AuthError("TOKEN_CONSUMED", "验证令牌已被使用。");
      case "EXPIRED":
        throw new AuthError("TOKEN_EXPIRED", "验证令牌已过期。");
      case "INVALID":
        throw new AuthError("TOKEN_INVALID", "验证令牌无效。");
    }
  }
}
