import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RATE_LIMIT_POLICIES,
  MemoryCompositeRateLimiter,
  MissingRateLimitIdentityError,
  RedisCompositeRateLimiter,
  type RateLimitPolicies,
  type RedisAtomicRateLimitRequest,
  type RedisCompositeRateLimitAdapter,
} from "../src/rate-limit/index.js";

const atomicPolicies: RateLimitPolicies = {
  "chat.send": {
    operation: "chat.send",
    rules: [
      { id: "ip", dimension: "ip", limit: 1, windowMs: 100, required: true },
      { id: "user", dimension: "user", limit: 2, windowMs: 300, required: true },
      { id: "global", dimension: "global", limit: 10, windowMs: 1_000 },
    ],
  },
};

describe("MemoryCompositeRateLimiter", () => {
  it("任一键超限时不部分消费其他键", async () => {
    const limiter = new MemoryCompositeRateLimiter({ policies: atomicPolicies });

    assert.equal(
      (
        await limiter.consume({
          operation: "chat.send",
          identity: { ip: "203.0.113.1", userId: "user-1" },
          now: 0,
        })
      ).allowed,
      true,
    );
    const rejected = await limiter.consume({
      operation: "chat.send",
      identity: { ip: "203.0.113.1", userId: "user-1" },
      now: 10,
    });
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.exceededKeys.length, 1);
    assert.match(rejected.exceededKeys[0] ?? "", /:ip:/u);

    // 上一次拒绝不能消耗 user/global，否则此请求会被提前拒绝。
    assert.equal(
      (
        await limiter.consume({
          operation: "chat.send",
          identity: { ip: "203.0.113.2", userId: "user-1" },
          now: 20,
        })
      ).allowed,
      true,
    );
    const userRejected = await limiter.consume({
      operation: "chat.send",
      identity: { ip: "203.0.113.3", userId: "user-1" },
      now: 30,
    });
    assert.equal(userRejected.allowed, false);
    assert.match(userRejected.exceededKeys[0] ?? "", /:user:/u);
  });

  it("返回全部超限键和所有阻断窗口中的最大 retryAfterMs", async () => {
    const limiter = new MemoryCompositeRateLimiter({
      policies: {
        "auth.login": {
          operation: "auth.login",
          rules: [
            { id: "ip", dimension: "ip", limit: 1, windowMs: 100, required: true },
            { id: "user", dimension: "user", limit: 1, windowMs: 300, required: true },
          ],
        },
      },
    });
    const identity = { ip: "198.51.100.8", userId: "user-8" };
    await limiter.consume({ operation: "auth.login", identity, now: 0 });
    const decision = await limiter.consume({
      operation: "auth.login",
      identity,
      now: 10,
    });

    assert.deepEqual(
      {
        allowed: decision.allowed,
        retryAfterMs: decision.retryAfterMs,
        exceededCount: decision.exceededKeys.length,
      },
      { allowed: false, retryAfterMs: 290, exceededCount: 2 },
    );
  });

  it("窗口 TTL 到期后清理桶并允许重新消费", async () => {
    const limiter = new MemoryCompositeRateLimiter({
      policies: {
        "auth.register": {
          operation: "auth.register",
          rules: [
            { id: "ip", dimension: "ip", limit: 1, windowMs: 100, required: true },
          ],
        },
      },
    });
    await limiter.consume({
      operation: "auth.register",
      identity: { ip: "192.0.2.5" },
      now: 0,
    });
    assert.equal(limiter.bucketCount, 1);
    assert.equal(limiter.sweep(99), 0);
    assert.equal(limiter.sweep(100), 1);
    assert.equal(limiter.bucketCount, 0);
    assert.equal(
      (
        await limiter.consume({
          operation: "auth.register",
          identity: { ip: "192.0.2.5" },
          now: 100,
        })
      ).allowed,
      true,
    );
  });

  it("必需身份缺失时失败关闭", async () => {
    const limiter = new MemoryCompositeRateLimiter();
    await assert.rejects(
      limiter.consume({
        operation: "chat.send",
        identity: {
          ip: "203.0.113.9",
          sessionId: "session-9",
          userId: "user-9",
        },
      }),
      (error: unknown) =>
        error instanceof MissingRateLimitIdentityError &&
        error.dimension === "room",
    );
  });
});

describe("默认策略", () => {
  it("覆盖 P0/P1 初始操作和全部组合维度", () => {
    const operations = new Set(Object.keys(DEFAULT_RATE_LIMIT_POLICIES));
    for (const operation of [
      "auth.login",
      "auth.register",
      "account.password.change",
      "email.verification.send",
      "email.password_reset.send",
      "match.join",
      "chat.send",
      "chat.typing",
      "game.report",
      "feedback.submit",
      "echo.consent",
      "echo.assignment",
      "echo.judgment",
      "echo.record.read",
      "echo.comment.read",
      "echo.comment.write",
      "echo.comment.like",
      "ai.request",
      "ws.handshake",
    ]) {
      assert.equal(operations.has(operation), true, `缺少操作 ${operation}`);
    }

    const dimensions = new Set(
      Object.values(DEFAULT_RATE_LIMIT_POLICIES).flatMap(
        (policy) => policy?.rules.map((rule) => rule.dimension) ?? [],
      ),
    );
    assert.deepEqual(
      [...dimensions].sort(),
      [
        "device",
        "email",
        "global",
        "ip",
        "room",
        "session",
        "subnet",
        "user",
        "user_ip",
      ],
    );

    const typingPolicy =
      DEFAULT_RATE_LIMIT_POLICIES["chat.typing"];
    assert.ok(typingPolicy, "缺少输入状态限流策略");
    const typingRules = typingPolicy.rules;
    for (const dimension of ["session", "user"] as const) {
      const rule = typingRules.find(
        (candidate) => candidate.dimension === dimension,
      );
      assert.ok(rule, `缺少输入心跳 ${dimension} 限流`);
      assert.ok(
        rule.limit >= 12,
        "1 秒心跳加开始/停止事件不应在连续输入 10 秒内误伤",
      );
    }
  });
});

describe("RedisCompositeRateLimiter", () => {
  it("向适配器传递一次完整原子请求而不绑定 Redis 客户端", async () => {
    let captured: RedisAtomicRateLimitRequest | undefined;
    const adapter: RedisCompositeRateLimitAdapter = {
      async consumeAtomically(request) {
        captured = request;
        return { allowed: true, retryAfterMs: 0, exceededKeys: [] };
      },
    };
    const limiter = new RedisCompositeRateLimiter({
      adapter,
      policies: atomicPolicies,
      namespace: "test-rate",
    });

    const decision = await limiter.consume({
      operation: "chat.send",
      identity: { ip: "203.0.113.1", userId: "user-1" },
      now: 42,
    });

    assert.equal(decision.allowed, true);
    assert.equal(captured?.now, 42);
    assert.equal(captured?.rules.length, 3);
    assert.equal(
      captured?.rules.every((rule) => rule.key.startsWith("test-rate:")),
      true,
    );
  });

  it("拒绝适配器返回未知超限键", async () => {
    const limiter = new RedisCompositeRateLimiter({
      policies: atomicPolicies,
      adapter: {
        async consumeAtomically() {
          return {
            allowed: false,
            retryAfterMs: 10,
            exceededKeys: ["unknown-key"],
          };
        },
      },
    });
    await assert.rejects(
      limiter.consume({
        operation: "chat.send",
        identity: { ip: "203.0.113.1", userId: "user-1" },
      }),
      /无效判定结果/u,
    );
  });
});
