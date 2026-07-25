import {
  MissingRateLimitIdentityError,
  RateLimitConfigurationError,
  type RateLimitDimension,
  type RateLimitIdentity,
  type RateLimitOperation,
  type RateLimitPolicies,
  type RateLimitPolicy,
  type ResolvedRateLimitRule,
} from "./types.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Demo 初始值来自账户防滥用方案与 docs/SECURITY.md。
 * 所有值都通过构造参数覆盖，禁止在路由中重复写死。
 */
export const DEFAULT_RATE_LIMIT_POLICIES: RateLimitPolicies = {
  "auth.register": {
    operation: "auth.register",
    rules: [
      { id: "ip-10m", dimension: "ip", limit: 5, windowMs: 10 * MINUTE, required: true },
      { id: "subnet-10m", dimension: "subnet", limit: 20, windowMs: 10 * MINUTE },
      { id: "device-1h", dimension: "device", limit: 3, windowMs: HOUR },
      { id: "global-10m", dimension: "global", limit: 500, windowMs: 10 * MINUTE },
    ],
  },
  "auth.login": {
    operation: "auth.login",
    rules: [
      { id: "ip-10m", dimension: "ip", limit: 30, windowMs: 10 * MINUTE, required: true },
      { id: "subnet-10m", dimension: "subnet", limit: 100, windowMs: 10 * MINUTE },
      { id: "device-10m", dimension: "device", limit: 20, windowMs: 10 * MINUTE },
      { id: "user-10m", dimension: "user", limit: 5, windowMs: 10 * MINUTE },
      { id: "user-ip-10m", dimension: "user_ip", limit: 5, windowMs: 10 * MINUTE },
      { id: "email-10m", dimension: "email", limit: 5, windowMs: 10 * MINUTE },
      { id: "global-10m", dimension: "global", limit: 3_000, windowMs: 10 * MINUTE },
    ],
  },
  "email.verification.send": {
    operation: "email.verification.send",
    rules: [
      { id: "email-1h", dimension: "email", limit: 3, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 10, windowMs: HOUR, required: true },
      { id: "device-1h", dimension: "device", limit: 5, windowMs: HOUR },
      { id: "global-1h", dimension: "global", limit: 1_000, windowMs: HOUR },
    ],
  },
  "email.verification.consume": {
    operation: "email.verification.consume",
    rules: [
      { id: "ip-10m", dimension: "ip", limit: 10, windowMs: 10 * MINUTE, required: true },
      { id: "device-10m", dimension: "device", limit: 10, windowMs: 10 * MINUTE },
      { id: "global-10m", dimension: "global", limit: 2_000, windowMs: 10 * MINUTE },
    ],
  },
  "email.password_reset.send": {
    operation: "email.password_reset.send",
    rules: [
      { id: "email-1h", dimension: "email", limit: 3, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 10, windowMs: HOUR, required: true },
      { id: "device-1h", dimension: "device", limit: 5, windowMs: HOUR },
      { id: "global-1h", dimension: "global", limit: 1_000, windowMs: HOUR },
    ],
  },
  "email.password_reset.consume": {
    operation: "email.password_reset.consume",
    rules: [
      { id: "ip-10m", dimension: "ip", limit: 10, windowMs: 10 * MINUTE, required: true },
      { id: "device-10m", dimension: "device", limit: 10, windowMs: 10 * MINUTE },
      { id: "global-10m", dimension: "global", limit: 2_000, windowMs: 10 * MINUTE },
    ],
  },
  "account.password.change": {
    operation: "account.password.change",
    rules: [
      { id: "user-10m", dimension: "user", limit: 5, windowMs: 10 * MINUTE, required: true },
      { id: "session-10m", dimension: "session", limit: 5, windowMs: 10 * MINUTE, required: true },
      { id: "device-1h", dimension: "device", limit: 10, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 20, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 1_000, windowMs: HOUR },
    ],
  },
  "match.join": {
    operation: "match.join",
    rules: [
      { id: "user-burst", dimension: "user", limit: 3, windowMs: 10 * SECOND, required: true },
      { id: "user-10m", dimension: "user", limit: 20, windowMs: 10 * MINUTE, required: true },
      { id: "device-10m", dimension: "device", limit: 10, windowMs: 10 * MINUTE, required: true },
      { id: "session-10m", dimension: "session", limit: 20, windowMs: 10 * MINUTE, required: true },
      { id: "ip-1m", dimension: "ip", limit: 60, windowMs: MINUTE, required: true },
      { id: "global-1m", dimension: "global", limit: 3_000, windowMs: MINUTE },
    ],
  },
  "match.cancel": {
    operation: "match.cancel",
    rules: [
      { id: "user-10m", dimension: "user", limit: 10, windowMs: 10 * MINUTE, required: true },
      { id: "device-10m", dimension: "device", limit: 15, windowMs: 10 * MINUTE },
      { id: "global-1m", dimension: "global", limit: 3_000, windowMs: MINUTE },
    ],
  },
  "chat.send": {
    operation: "chat.send",
    rules: [
      { id: "user-burst", dimension: "user", limit: 3, windowMs: 5 * SECOND, required: true },
      { id: "user-1m", dimension: "user", limit: 30, windowMs: MINUTE, required: true },
      { id: "session-1m", dimension: "session", limit: 30, windowMs: MINUTE, required: true },
      { id: "room-1m", dimension: "room", limit: 40, windowMs: MINUTE, required: true },
      { id: "ip-1m", dimension: "ip", limit: 120, windowMs: MINUTE, required: true },
      { id: "global-1m", dimension: "global", limit: 20_000, windowMs: MINUTE },
    ],
  },
  "chat.typing": {
    operation: "chat.typing",
    rules: [
      { id: "session-10s", dimension: "session", limit: 15, windowMs: 10 * SECOND, required: true },
      { id: "user-10s", dimension: "user", limit: 15, windowMs: 10 * SECOND, required: true },
      { id: "room-10s", dimension: "room", limit: 40, windowMs: 10 * SECOND, required: true },
      { id: "global-1m", dimension: "global", limit: 50_000, windowMs: MINUTE },
    ],
  },
  "game.report": {
    operation: "game.report",
    rules: [
      { id: "user-1d", dimension: "user", limit: 5, windowMs: DAY, required: true },
      { id: "device-1d", dimension: "device", limit: 5, windowMs: DAY, required: true },
      { id: "session-1d", dimension: "session", limit: 5, windowMs: DAY, required: true },
      { id: "room-1d", dimension: "room", limit: 2, windowMs: DAY, required: true },
      { id: "global-1d", dimension: "global", limit: 2_000, windowMs: DAY },
    ],
  },
  "feedback.submit": {
    operation: "feedback.submit",
    rules: [
      { id: "user-1d", dimension: "user", limit: 5, windowMs: DAY, required: true },
      { id: "device-1d", dimension: "device", limit: 5, windowMs: DAY, required: true },
      { id: "session-1d", dimension: "session", limit: 5, windowMs: DAY, required: true },
      { id: "ip-1d", dimension: "ip", limit: 20, windowMs: DAY, required: true },
      { id: "global-1d", dimension: "global", limit: 1_000, windowMs: DAY },
    ],
  },
  "echo.consent": {
    operation: "echo.consent",
    rules: [
      { id: "user-1h", dimension: "user", limit: 30, windowMs: HOUR, required: true },
      { id: "session-1h", dimension: "session", limit: 30, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 120, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 10_000, windowMs: HOUR },
    ],
  },
  "echo.assignment": {
    operation: "echo.assignment",
    rules: [
      { id: "user-1h", dimension: "user", limit: 60, windowMs: HOUR, required: true },
      { id: "device-1h", dimension: "device", limit: 60, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 240, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 20_000, windowMs: HOUR },
    ],
  },
  "echo.judgment": {
    operation: "echo.judgment",
    rules: [
      { id: "user-1h", dimension: "user", limit: 60, windowMs: HOUR, required: true },
      { id: "session-1h", dimension: "session", limit: 60, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 240, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 20_000, windowMs: HOUR },
    ],
  },
  "echo.record.read": {
    operation: "echo.record.read",
    rules: [
      { id: "user-1h", dimension: "user", limit: 120, windowMs: HOUR, required: true },
      { id: "session-1h", dimension: "session", limit: 120, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 480, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 40_000, windowMs: HOUR },
    ],
  },
  "echo.comment.read": {
    operation: "echo.comment.read",
    rules: [
      { id: "user-1h", dimension: "user", limit: 240, windowMs: HOUR, required: true },
      { id: "session-1h", dimension: "session", limit: 240, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 600, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 50_000, windowMs: HOUR },
    ],
  },
  "echo.comment.write": {
    operation: "echo.comment.write",
    rules: [
      { id: "user-1h", dimension: "user", limit: 20, windowMs: HOUR, required: true },
      { id: "session-1h", dimension: "session", limit: 20, windowMs: HOUR, required: true },
      { id: "assignment-1h", dimension: "room", limit: 20, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 80, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 10_000, windowMs: HOUR },
    ],
  },
  "echo.comment.like": {
    operation: "echo.comment.like",
    rules: [
      { id: "user-1h", dimension: "user", limit: 120, windowMs: HOUR, required: true },
      { id: "session-1h", dimension: "session", limit: 120, windowMs: HOUR, required: true },
      { id: "ip-1h", dimension: "ip", limit: 480, windowMs: HOUR, required: true },
      { id: "global-1h", dimension: "global", limit: 40_000, windowMs: HOUR },
    ],
  },
  "ai.request": {
    operation: "ai.request",
    rules: [
      { id: "room-30m", dimension: "room", limit: 10, windowMs: 30 * MINUTE, required: true },
      { id: "user-1d", dimension: "user", limit: 50, windowMs: DAY, required: true },
      { id: "device-1d", dimension: "device", limit: 30, windowMs: DAY, required: true },
      { id: "ip-1h", dimension: "ip", limit: 100, windowMs: HOUR, required: true },
      { id: "subnet-1h", dimension: "subnet", limit: 500, windowMs: HOUR },
      { id: "global-1m", dimension: "global", limit: 100, windowMs: MINUTE },
    ],
  },
  "ws.handshake": {
    operation: "ws.handshake",
    rules: [
      { id: "ip-1m", dimension: "ip", limit: 20, windowMs: MINUTE, required: true },
      { id: "subnet-1m", dimension: "subnet", limit: 100, windowMs: MINUTE },
      { id: "device-1m", dimension: "device", limit: 30, windowMs: MINUTE },
      { id: "session-1m", dimension: "session", limit: 20, windowMs: MINUTE },
      { id: "user-1m", dimension: "user", limit: 20, windowMs: MINUTE },
      { id: "global-1m", dimension: "global", limit: 5_000, windowMs: MINUTE },
    ],
  },
};

function safeSegment(value: string): string {
  return encodeURIComponent(value.normalize("NFKC"));
}

function identityValue(
  dimension: RateLimitDimension,
  identity: RateLimitIdentity,
): string | undefined {
  switch (dimension) {
    case "ip":
      return identity.ip;
    case "subnet":
      return identity.subnet;
    case "device":
      return identity.deviceId;
    case "session":
      return identity.sessionId;
    case "user":
      return identity.userId;
    case "user_ip":
      return identity.userId && identity.ip
        ? `${identity.userId}:${identity.ip}`
        : undefined;
    case "email":
      return identity.emailHash;
    case "room":
      return identity.roomId;
    case "global":
      return "all";
  }
}

export function validateRateLimitPolicies(policies: RateLimitPolicies): void {
  for (const [operation, policy] of Object.entries(policies)) {
    if (!policy) continue;
    if (policy.operation !== operation) {
      throw new RateLimitConfigurationError(
        `限流策略键 ${operation} 与策略操作 ${policy.operation} 不一致`,
      );
    }
    const ids = new Set<string>();
    for (const rule of policy.rules) {
      if (!rule.id.trim() || ids.has(rule.id)) {
        throw new RateLimitConfigurationError(
          `限流策略 ${operation} 包含空值或重复规则 ID：${rule.id}`,
        );
      }
      if (
        !Number.isSafeInteger(rule.limit) ||
        rule.limit <= 0 ||
        !Number.isSafeInteger(rule.windowMs) ||
        rule.windowMs <= 0
      ) {
        throw new RateLimitConfigurationError(
          `限流规则 ${operation}/${rule.id} 的 limit 和 windowMs 必须是正整数`,
        );
      }
      ids.add(rule.id);
    }
  }
}

export function resolveRateLimitRules(
  operation: RateLimitOperation,
  identity: RateLimitIdentity,
  policies: RateLimitPolicies,
  namespace = "rate",
): ResolvedRateLimitRule[] {
  const policy: RateLimitPolicy | undefined = policies[operation];
  if (!policy) {
    throw new RateLimitConfigurationError(`未配置限流操作：${operation}`);
  }
  return policy.rules.flatMap((rule) => {
    const value = identityValue(rule.dimension, identity);
    if (!value) {
      if (rule.required) {
        throw new MissingRateLimitIdentityError(operation, rule.dimension);
      }
      return [];
    }
    return [{
      ...rule,
      key: [
        safeSegment(namespace),
        safeSegment(operation),
        safeSegment(rule.id),
        safeSegment(rule.dimension),
        safeSegment(value),
      ].join(":"),
    }];
  });
}
