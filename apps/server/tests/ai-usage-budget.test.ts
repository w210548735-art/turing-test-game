import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiReservationConflictError,
  AiUsageBudgetService,
  type AiUsageBudgetConfig,
  type AiUsageIdentity,
} from "../src/ai/usage-budget.js";

const identity: AiUsageIdentity = {
  roomId: "room-1",
  userId: "user-1",
  deviceId: "device-1",
  ip: "203.0.113.1",
};

function config(overrides: {
  room?: Partial<AiUsageBudgetConfig["room"]>;
  user?: Partial<AiUsageBudgetConfig["user"]>;
  device?: Partial<AiUsageBudgetConfig["device"]>;
  ip?: Partial<AiUsageBudgetConfig["ip"]>;
  global?: Partial<AiUsageBudgetConfig["global"]>;
} = {}): AiUsageBudgetConfig {
  const base = {
    hourlyCalls: 100,
    dailyCalls: 1_000,
    hourlyTokens: 10_000,
    dailyTokens: 100_000,
  };
  return {
    room: { ...base, ...overrides.room },
    user: { ...base, ...overrides.user },
    device: { ...base, ...overrides.device },
    ip: { ...base, ...overrides.ip },
    global: { ...base, ...overrides.global },
  };
}

describe("AI 多维用量预算", () => {
  it("同一 room 同时只允许一个 reservation，取消后释放并发", async () => {
    const service = new AiUsageBudgetService({ config: config() });
    const first = await service.reserve({
      reservationId: "reservation-1",
      identity,
      estimatedTokens: 100,
      now: 0,
    });
    assert.equal(first.allowed, true);

    const concurrent = await service.reserve({
      reservationId: "reservation-2",
      identity,
      estimatedTokens: 100,
      now: 1,
    });
    assert.equal(concurrent.allowed, false);
    if (!concurrent.allowed) {
      assert.equal(
        concurrent.exceeded.some(
          (entry) =>
            entry.dimension === "room" && entry.metric === "concurrency",
        ),
        true,
      );
    }

    const cancelled = await service.settle({
      reservationId: "reservation-1",
      outcome: "cancelled",
      promptTokens: 8,
      completionTokens: 0,
      now: 2,
    });
    assert.equal(cancelled.reservation.state, "settled");
    assert.equal(cancelled.reservation.outcome, "cancelled");
    assert.equal(
      (
        await service.reserve({
          reservationId: "reservation-2",
          identity,
          estimatedTokens: 100,
          now: 3,
        })
      ).allowed,
      true,
    );
  });

  it("任一维度超限时不会部分消费 room 或 global", async () => {
    const service = new AiUsageBudgetService({
      config: config({
        user: { hourlyCalls: 1 },
      }),
    });
    await service.reserve({
      reservationId: "first",
      identity,
      estimatedTokens: 10,
      now: 0,
    });
    await service.settle({
      reservationId: "first",
      outcome: "success",
      promptTokens: 4,
      completionTokens: 2,
      now: 1,
    });

    const rejected = await service.reserve({
      reservationId: "rejected",
      identity: { ...identity, roomId: "room-unused" },
      estimatedTokens: 10,
      now: 2,
    });
    assert.equal(rejected.allowed, false);

    // 换用户、设备和 IP 后复用 room；若拒绝发生了部分消费，这里会留下额外调用。
    const allowed = await service.reserve({
      reservationId: "after-reject",
      identity: {
        roomId: "room-unused",
        userId: "user-2",
        deviceId: "device-2",
        ip: "203.0.113.2",
      },
      estimatedTokens: 10,
      now: 3,
    });
    assert.equal(allowed.allowed, true);
  });

  it("reserve 使用最大预计 Token，settle 后按实际 Token 释放余量", async () => {
    const service = new AiUsageBudgetService({
      config: config({
        user: { hourlyTokens: 100, dailyTokens: 100 },
      }),
    });
    await service.reserve({
      reservationId: "large-estimate",
      identity,
      estimatedTokens: 80,
      now: 0,
    });
    const blocked = await service.reserve({
      reservationId: "blocked-by-reserve",
      identity: { ...identity, roomId: "room-2" },
      estimatedTokens: 30,
      now: 1,
    });
    assert.equal(blocked.allowed, false);

    await service.settle({
      reservationId: "large-estimate",
      outcome: "success",
      promptTokens: 15,
      completionTokens: 5,
      now: 2,
    });
    const afterSettle = await service.reserve({
      reservationId: "blocked-by-reserve",
      identity: { ...identity, roomId: "room-2" },
      estimatedTokens: 30,
      now: 3,
    });
    assert.equal(afterSettle.allowed, true);
  });

  it("失败结算释放并发但不退还调用次数", async () => {
    const service = new AiUsageBudgetService({
      config: config({
        user: { hourlyCalls: 1 },
      }),
    });
    await service.reserve({
      reservationId: "failed-call",
      identity,
      estimatedTokens: 20,
      now: 0,
    });
    await service.settle({
      reservationId: "failed-call",
      outcome: "failed",
      promptTokens: 0,
      completionTokens: 0,
      now: 1,
    });
    const next = await service.reserve({
      reservationId: "second-call",
      identity: { ...identity, roomId: "room-2" },
      estimatedTokens: 20,
      now: 2,
    });
    assert.equal(next.allowed, false);
    if (!next.allowed) {
      assert.equal(
        next.exceeded.some(
          (entry) =>
            entry.dimension === "user" &&
            entry.metric === "hourly_calls",
        ),
        true,
      );
    }
  });

  it("reserve 与 settle 均支持同参数幂等重放并拒绝冲突", async () => {
    const service = new AiUsageBudgetService({ config: config() });
    const request = {
      reservationId: "idempotent",
      identity,
      estimatedTokens: 50,
      now: 0,
    };
    assert.equal((await service.reserve(request)).idempotentReplay, false);
    assert.equal((await service.reserve(request)).idempotentReplay, true);
    await assert.rejects(
      service.reserve({ ...request, estimatedTokens: 51 }),
      AiReservationConflictError,
    );

    const settlement = {
      reservationId: "idempotent",
      outcome: "success" as const,
      promptTokens: 10,
      completionTokens: 4,
      now: 1,
    };
    assert.equal((await service.settle(settlement)).idempotentReplay, false);
    assert.equal((await service.settle(settlement)).idempotentReplay, true);
    await assert.rejects(
      service.settle({ ...settlement, completionTokens: 5 }),
      AiReservationConflictError,
    );
  });

  it("同时执行滚动小时和日调用窗口", async () => {
    const service = new AiUsageBudgetService({
      config: config({
        user: { hourlyCalls: 1, dailyCalls: 2 },
      }),
    });
    const call = async (id: string, roomId: string, now: number) => {
      const reserved = await service.reserve({
        reservationId: id,
        identity: { ...identity, roomId },
        estimatedTokens: 1,
        now,
      });
      if (reserved.allowed) {
        await service.settle({
          reservationId: id,
          outcome: "success",
          promptTokens: 1,
          completionTokens: 0,
          now,
        });
      }
      return reserved;
    };

    assert.equal((await call("hour-1", "room-1", 0)).allowed, true);
    assert.equal(
      (await call("hour-2", "room-2", 60 * 60_000)).allowed,
      true,
    );
    const dailyBlocked = await call("day-blocked", "room-3", 2 * 60 * 60_000);
    assert.equal(dailyBlocked.allowed, false);
    if (!dailyBlocked.allowed) {
      assert.equal(
        dailyBlocked.exceeded.some(
          (entry) =>
            entry.dimension === "user" && entry.metric === "daily_calls",
        ),
        true,
      );
    }
    assert.equal(
      (await call("next-day", "room-4", 24 * 60 * 60_000)).allowed,
      true,
    );
  });

  it("实际 Token 超出预留时仍完整记账并阻止后续调用", async () => {
    const service = new AiUsageBudgetService({
      config: config({
        user: { hourlyTokens: 100, dailyTokens: 100 },
      }),
    });
    await service.reserve({
      reservationId: "overage",
      identity,
      estimatedTokens: 50,
      now: 0,
    });
    const settled = await service.settle({
      reservationId: "overage",
      outcome: "success",
      promptTokens: 90,
      completionTokens: 30,
      now: 1,
    });
    assert.equal(settled.overageTokens, 70);
    assert.equal(
      settled.exceededAfterSettle.some(
        (entry) =>
          entry.dimension === "user" &&
          entry.metric === "daily_tokens",
      ),
      true,
    );

    const blocked = await service.reserve({
      reservationId: "after-overage",
      identity: { ...identity, roomId: "room-2" },
      estimatedTokens: 1,
      now: 2,
    });
    assert.equal(blocked.allowed, false);
  });
});
