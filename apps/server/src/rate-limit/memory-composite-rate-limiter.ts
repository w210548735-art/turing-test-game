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

interface WindowBucket {
  timestamps: number[];
  expiresAt: number;
}

export interface MemoryCompositeRateLimiterOptions {
  policies?: RateLimitPolicies;
  namespace?: string;
  now?: () => number;
}

/**
 * 单进程 Demo 使用的滑动窗口组合限流器。
 * 一次请求的所有维度先完整评估，任一维度超限时不会消费其他维度。
 */
export class MemoryCompositeRateLimiter implements CompositeRateLimiter {
  private readonly policies: RateLimitPolicies;
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly buckets = new Map<string, WindowBucket>();

  constructor(options: MemoryCompositeRateLimiterOptions = {}) {
    this.policies = options.policies ?? DEFAULT_RATE_LIMIT_POLICIES;
    this.namespace = options.namespace ?? "rate";
    this.now = options.now ?? Date.now;
    validateRateLimitPolicies(this.policies);
  }

  async consume(
    request: CompositeRateLimitRequest,
  ): Promise<CompositeRateLimitDecision> {
    const now = request.now ?? this.now();
    this.sweep(now);
    const rules = resolveRateLimitRules(
      request.operation,
      request.identity,
      this.policies,
      this.namespace,
    );
    const evaluated = rules.map((rule) => ({
      rule,
      timestamps: this.activeTimestamps(rule, now),
    }));
    const exceeded = evaluated.filter(
      ({ rule, timestamps }) => timestamps.length >= rule.limit,
    );

    if (exceeded.length > 0) {
      return {
        allowed: false,
        retryAfterMs: Math.max(
          ...exceeded.map(({ rule, timestamps }) =>
            this.retryAfter(rule, timestamps, now),
          ),
        ),
        exceededKeys: exceeded.map(({ rule }) => rule.key),
      };
    }

    for (const { rule, timestamps } of evaluated) {
      timestamps.push(now);
      this.buckets.set(rule.key, {
        timestamps,
        expiresAt: now + rule.windowMs,
      });
    }
    return { allowed: true, retryAfterMs: 0, exceededKeys: [] };
  }

  /**
   * 公开清理入口便于定时任务和测试显式触发；正常 consume 也会自动清理。
   */
  sweep(now = this.now()): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }

  private activeTimestamps(
    rule: ResolvedRateLimitRule,
    now: number,
  ): number[] {
    const cutoff = now - rule.windowMs;
    return (this.buckets.get(rule.key)?.timestamps ?? [])
      .filter((timestamp) => timestamp > cutoff)
      .sort((left, right) => left - right);
  }

  private retryAfter(
    rule: ResolvedRateLimitRule,
    timestamps: number[],
    now: number,
  ): number {
    const expirationsNeeded = timestamps.length - rule.limit + 1;
    const blockingTimestamp = timestamps[expirationsNeeded - 1];
    if (blockingTimestamp === undefined) return rule.windowMs;
    return Math.max(1, blockingTimestamp + rule.windowMs - now);
  }
}
