import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface CaptchaProvider {
  verify(input: {
    readonly response: string;
    readonly action: string;
    readonly remoteIp?: string;
  }): Promise<boolean>;
}

interface CaptchaTicket {
  readonly tokenHash: string;
  readonly action: string;
  readonly expiresAtMs: number;
}

export interface IssuedCaptchaTicket {
  readonly token: string;
  readonly action: string;
  readonly expiresAt: Date;
}

/**
 * 将第三方验证码结果绑定到具体业务动作，并通过一次性 Ticket 阻止验证码
 * 在登录、匹配、AI 调用等不同动作间复用。
 */
export class ActionBoundCaptchaService {
  readonly #tickets = new Map<string, CaptchaTicket>();

  constructor(
    private readonly provider: CaptchaProvider,
    private readonly ttlMs = 2 * 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError("验证码 Ticket 有效期必须大于 0");
    }
  }

  issue(action: string): IssuedCaptchaTicket {
    assertAction(action);
    const now = this.now();
    if (Number.isNaN(now.getTime())) throw new TypeError("当前时间不合法");
    this.#removeExpired(now.getTime());

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAtMs = now.getTime() + this.ttlMs;
    this.#tickets.set(tokenHash, { tokenHash, action, expiresAtMs });
    return {
      token,
      action,
      expiresAt: new Date(expiresAtMs),
    };
  }

  async verify(input: {
    readonly token: string;
    readonly action: string;
    readonly response: string;
    readonly remoteIp?: string;
  }): Promise<boolean> {
    if (!input.token || !input.action || !input.response) return false;
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs)) return false;

    const presentedHash = hashToken(input.token);
    const ticket = this.#findTicket(presentedHash);
    if (!ticket) return false;

    // 找到后先消费，保证并发请求也只能有一个进入供应商验证。
    this.#tickets.delete(ticket.tokenHash);
    if (ticket.expiresAtMs <= nowMs || ticket.action !== input.action) {
      return false;
    }

    return this.provider.verify({
      response: input.response,
      action: input.action,
      ...(input.remoteIp ? { remoteIp: input.remoteIp } : {}),
    });
  }

  #findTicket(presentedHash: string): CaptchaTicket | undefined {
    const presented = Buffer.from(presentedHash, "hex");
    for (const ticket of this.#tickets.values()) {
      const stored = Buffer.from(ticket.tokenHash, "hex");
      if (timingSafeEqual(presented, stored)) return ticket;
    }
    return undefined;
  }

  #removeExpired(nowMs: number): void {
    for (const [hash, ticket] of this.#tickets) {
      if (ticket.expiresAtMs <= nowMs) this.#tickets.delete(hash);
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertAction(action: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(action)) {
    throw new TypeError("验证码动作名称不合法");
  }
}
