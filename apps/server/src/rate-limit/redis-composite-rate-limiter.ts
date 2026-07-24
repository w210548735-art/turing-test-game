import {
  DEFAULT_RATE_LIMIT_POLICIES,
  resolveRateLimitRules,
  validateRateLimitPolicies,
} from "./policies.js";
import type {
  CompositeRateLimitDecision,
  CompositeRateLimiter,
  CompositeRateLimitRequest,
  RateLimitPolicies,
  ResolvedRateLimitRule,
} from "./types.js";

export interface RedisAtomicRateLimitRequest {
  now: number;
  rules: readonly ResolvedRateLimitRule[];
}

/**
 * 适配器实现必须用单条 Lua 脚本或等价事务一次完成：
 * 清理过期成员、评估所有键、全量消费或全部不消费、设置窗口 TTL。
 */
export interface RedisCompositeRateLimitAdapter {
  consumeAtomically(
    request: RedisAtomicRateLimitRequest,
  ): Promise<CompositeRateLimitDecision>;
}

export interface RedisCompositeRateLimiterOptions {
  adapter: RedisCompositeRateLimitAdapter;
  policies?: RateLimitPolicies;
  namespace?: string;
  now?: () => number;
}

/**
 * Redis 组合限流器只依赖原子适配契约，不绑定 ioredis 或具体脚本布局。
 */
export class RedisCompositeRateLimiter implements CompositeRateLimiter {
  private readonly adapter: RedisCompositeRateLimitAdapter;
  private readonly policies: RateLimitPolicies;
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(options: RedisCompositeRateLimiterOptions) {
    this.adapter = options.adapter;
    this.policies = options.policies ?? DEFAULT_RATE_LIMIT_POLICIES;
    this.namespace = options.namespace ?? "rate";
    this.now = options.now ?? Date.now;
    validateRateLimitPolicies(this.policies);
  }

  async consume(
    request: CompositeRateLimitRequest,
  ): Promise<CompositeRateLimitDecision> {
    const now = request.now ?? this.now();
    const rules = resolveRateLimitRules(
      request.operation,
      request.identity,
      this.policies,
      this.namespace,
    );
    const decision = await this.adapter.consumeAtomically({ now, rules });
    const knownKeys = new Set(rules.map((rule) => rule.key));
    if (
      !Number.isSafeInteger(decision.retryAfterMs) ||
      decision.retryAfterMs < 0 ||
      decision.exceededKeys.some((key) => !knownKeys.has(key)) ||
      (decision.allowed &&
        (decision.retryAfterMs !== 0 || decision.exceededKeys.length > 0))
    ) {
      throw new Error("Redis 限流适配器返回了无效判定结果");
    }
    return decision;
  }
}
