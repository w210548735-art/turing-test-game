export type RateLimitDimension =
  | "ip"
  | "subnet"
  | "device"
  | "session"
  | "user"
  | "user_ip"
  | "email"
  | "room"
  | "global";

export type RateLimitOperation =
  | "auth.login"
  | "auth.register"
  | "email.verification.send"
  | "email.verification.consume"
  | "email.password_reset.send"
  | "email.password_reset.consume"
  | "account.password.change"
  | "match.join"
  | "match.cancel"
  | "chat.send"
  | "chat.typing"
  | "game.report"
  | "feedback.submit"
  | "echo.consent"
  | "echo.assignment"
  | "echo.judgment"
  | "echo.record.read"
  | "echo.comment.read"
  | "echo.comment.write"
  | "echo.comment.like"
  | "ai.request"
  | "ws.handshake";

export interface RateLimitIdentity {
  ip?: string;
  subnet?: string;
  deviceId?: string;
  sessionId?: string;
  userId?: string;
  /**
   * 必须由调用方传入规范化邮箱的不可逆摘要，禁止把明文邮箱写入限流键。
   */
  emailHash?: string;
  roomId?: string;
}

export interface RateLimitRule {
  id: string;
  dimension: RateLimitDimension;
  limit: number;
  windowMs: number;
  /**
   * 必需维度缺失时拒绝执行，避免调用方漏传关键身份后绕过限流。
   */
  required?: boolean;
}

export interface RateLimitPolicy {
  operation: RateLimitOperation;
  rules: readonly RateLimitRule[];
}

export type RateLimitPolicies = Readonly<
  Partial<Record<RateLimitOperation, RateLimitPolicy>>
>;

export interface CompositeRateLimitRequest {
  operation: RateLimitOperation;
  identity: RateLimitIdentity;
  now?: number;
}

export interface CompositeRateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  exceededKeys: string[];
}

export interface ResolvedRateLimitRule extends RateLimitRule {
  key: string;
}

export interface CompositeRateLimiter {
  consume(
    request: CompositeRateLimitRequest,
  ): Promise<CompositeRateLimitDecision>;
}

export class RateLimitConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitConfigurationError";
  }
}

export class MissingRateLimitIdentityError extends Error {
  constructor(
    public readonly operation: RateLimitOperation,
    public readonly dimension: RateLimitDimension,
  ) {
    super(`限流操作 ${operation} 缺少必需身份维度 ${dimension}`);
    this.name = "MissingRateLimitIdentityError";
  }
}
