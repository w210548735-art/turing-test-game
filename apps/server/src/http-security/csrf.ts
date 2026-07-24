import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface IssuedCsrfToken {
  /** 仅发送给客户端，不写入服务端日志或数据库。 */
  readonly token: string;
  /** 写入对应服务端 Session 的摘要。 */
  readonly hash: string;
  readonly issuedAt: Date;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * CSRF Token 与服务端 Session 绑定。数据库只需保存 hash；即使摘要泄露，
 * 也不能直接把它当作 Token 使用。
 */
export class SessionBoundCsrfService {
  readonly #secret: Buffer;

  constructor(secret: string | Uint8Array) {
    const buffer =
      typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
    if (buffer.byteLength < 32) {
      throw new TypeError("CSRF 服务密钥至少需要 32 字节");
    }
    this.#secret = Buffer.from(buffer);
  }

  issue(sessionId: string, now = new Date()): IssuedCsrfToken {
    this.#assertSessionId(sessionId);
    if (Number.isNaN(now.getTime())) {
      throw new TypeError("CSRF 签发时间不合法");
    }
    const token = randomBytes(32).toString("base64url");
    return {
      token,
      hash: this.#hash(sessionId, token),
      issuedAt: new Date(now),
    };
  }

  /**
   * 登录、权限提升和敏感操作后调用轮换。调用方应以返回的新 hash 原子替换
   * Session 中的旧 hash；旧 Token 随即失效。
   */
  rotate(sessionId: string, now = new Date()): IssuedCsrfToken {
    return this.issue(sessionId, now);
  }

  verify(
    sessionId: string,
    presentedToken: string | undefined,
    storedHash: string | undefined,
  ): boolean {
    if (
      !sessionId ||
      !presentedToken ||
      !storedHash ||
      !SHA256_HEX_PATTERN.test(storedHash)
    ) {
      return false;
    }

    const actual = Buffer.from(this.#hash(sessionId, presentedToken), "hex");
    const expected = Buffer.from(storedHash, "hex");
    // 长度在格式检查后固定为 32 字节，再进行恒时比较。
    return timingSafeEqual(actual, expected);
  }

  #hash(sessionId: string, token: string): string {
    return createHmac("sha256", this.#secret)
      .update("csrf:v1\0", "utf8")
      .update(sessionId, "utf8")
      .update("\0", "utf8")
      .update(token, "utf8")
      .digest("hex");
  }

  #assertSessionId(sessionId: string): void {
    if (!sessionId || sessionId.length > 512) {
      throw new TypeError("Session ID 不合法");
    }
  }
}
