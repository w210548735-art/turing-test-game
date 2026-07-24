const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type OriginDecisionReason =
  | "ALLOWED"
  | "MISSING_ORIGIN"
  | "DISALLOWED_ORIGIN";

export type OriginDecision =
  | {
      readonly allowed: true;
      readonly reason: "ALLOWED";
    }
  | {
      readonly allowed: false;
      readonly reason: Exclude<OriginDecisionReason, "ALLOWED">;
    };

/**
 * Origin 仅与显式白名单做字符串精确匹配。这里有意不接收 Host，
 * 也不根据 Host 推导可信来源，防止代理头配置错误扩大信任边界。
 */
export class OriginPolicy {
  readonly #allowedOrigins: ReadonlySet<string>;

  constructor(allowedOrigins: readonly string[]) {
    if (allowedOrigins.length === 0) {
      throw new TypeError("Origin 白名单不能为空");
    }
    const unique = new Set<string>();
    for (const origin of allowedOrigins) {
      assertOriginOnly(origin);
      unique.add(origin);
    }
    this.#allowedOrigins = unique;
  }

  evaluateHttp(method: string, origin: string | undefined): OriginDecision {
    const normalizedMethod = method.toUpperCase();
    if (!origin) {
      return SAFE_HTTP_METHODS.has(normalizedMethod)
        ? { allowed: true, reason: "ALLOWED" }
        : { allowed: false, reason: "MISSING_ORIGIN" };
    }
    return this.#matches(origin);
  }

  evaluateWebSocket(origin: string | undefined): OriginDecision {
    if (!origin) {
      return { allowed: false, reason: "MISSING_ORIGIN" };
    }
    return this.#matches(origin);
  }

  assertHttp(method: string, origin: string | undefined): void {
    const decision = this.evaluateHttp(method, origin);
    if (!decision.allowed) throw new OriginPolicyError(decision.reason);
  }

  assertWebSocket(origin: string | undefined): void {
    const decision = this.evaluateWebSocket(origin);
    if (!decision.allowed) throw new OriginPolicyError(decision.reason);
  }

  #matches(origin: string): OriginDecision {
    return this.#allowedOrigins.has(origin)
      ? { allowed: true, reason: "ALLOWED" }
      : { allowed: false, reason: "DISALLOWED_ORIGIN" };
  }
}

export class OriginPolicyError extends Error {
  constructor(
    public readonly code: Exclude<OriginDecisionReason, "ALLOWED">,
  ) {
    super(
      code === "MISSING_ORIGIN"
        ? "请求缺少 Origin"
        : "请求 Origin 不在允许列表中",
    );
    this.name = "OriginPolicyError";
  }
}

function assertOriginOnly(origin: string): void {
  if (!origin || origin === "null" || origin.trim() !== origin) {
    throw new TypeError(`Origin 白名单项不合法: ${origin}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`Origin 白名单项不合法: ${origin}`);
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== origin
  ) {
    throw new TypeError(`Origin 白名单项必须是规范化的 HTTP(S) Origin: ${origin}`);
  }
}
