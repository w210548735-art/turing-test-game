import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdmissionService,
  AiBudgetController,
} from "../src/matchmaking/index.js";
import {
  createMemoryRedisRuntime,
  WsTicketStore,
} from "../src/redis/index.js";
import { RoomSnapshotStore } from "../src/rooms/index.js";

describe("AI 配额与真人优先匹配", () => {
  it("样本不足以保持30%硬上限时继续等待真人", async () => {
    const controller = new AiBudgetController();
    const blocked = await controller.reserveAiGame();
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "recent_10_limit");
  });

  it("低流量且没有真人候选时允许 AI 延迟兜底", async () => {
    const controller = new AiBudgetController();
    const allowed = await controller.reserveAiGame({
      allowLatencyOverride: true,
    });

    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, "latency_override");
    assert.equal(allowed.stats.recent10AiGames, 1);
  });

  it("最近十局最多创建三局 AI", async () => {
    const controller = new AiBudgetController();
    for (let index = 0; index < 7; index += 1) {
      await controller.recordHumanGame();
    }

    for (let index = 0; index < 3; index += 1) {
      const decision = await controller.reserveAiGame();
      assert.equal(decision.allowed, true);
    }
    const blocked = await controller.reserveAiGame();
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "recent_10_limit");
    assert.equal(blocked.stats.recent10Games, 10);
    assert.equal(blocked.stats.recent10AiGames, 3);
  });

  it("五秒门结束后优先组成真人局，不因 AI 目标拆分真人", async () => {
    let now = 10_000;
    const service = new AdmissionService({ now: () => now });
    const first = await service.joinAdmission({
      userId: "human-a",
      sessionId: "session-a",
    });
    await service.joinAdmission({
      userId: "human-b",
      sessionId: "session-b",
    });

    now += 5_000;
    const assignments = await service.finalizeAdmission(first.bucketId);
    assert.deepEqual(assignments, [
      {
        kind: "human",
        playerIds: ["human-a", "human-b"],
        matchedAt: now,
        bucketId: first.bucketId,
      },
    ]);
    assert.equal((await service.listWaiting()).length, 0);
  });

  it("已有真人正在等待完整五秒门时，不用 AI 抢走到期玩家", async () => {
    let now = 20_000;
    const service = new AdmissionService({ now: () => now });
    const first = await service.joinAdmission({
      userId: "early",
      sessionId: "session-early",
    });
    now += 5_000;
    await service.joinAdmission({
      userId: "incoming",
      sessionId: "session-incoming",
    });

    const assignments = await service.finalizeAdmission(first.bucketId);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]?.kind, "waiting");
    if (assignments[0]?.kind === "waiting") {
      assert.equal(assignments[0].reason, "human_pending");
    }
    assert.equal((await service.listWaiting()).length, 2);
  });

  it("只有一名玩家时在首轮五秒结束后直接分配 AI", async () => {
    let now = 30_000;
    const service = new AdmissionService({ now: () => now });
    const ticket = await service.joinAdmission({
      userId: "solo",
      sessionId: "session-solo",
    });

    now += 5_000;
    const assignments = await service.finalizeAdmission(ticket.bucketId);

    assert.deepEqual(assignments, [
      {
        kind: "ai",
        playerIds: ["solo"],
        matchedAt: now,
        bucketId: ticket.bucketId,
      },
    ]);
  });
});

describe("恢复票据与房间消息补发", () => {
  it("WebSocket ticket 只能成功消费一次", async () => {
    let now = 1_000;
    const runtime = createMemoryRedisRuntime();
    const store = new WsTicketStore({
      runtime,
      now: () => now,
      ttlMs: 30_000,
    });
    const secondStore = new WsTicketStore({
      runtime,
      now: () => now,
      ttlMs: 30_000,
    });
    const issued = await store.issue({
      userId: "user-1",
      sessionId: "session-1",
    });

    const first = await secondStore.consume(issued.ticket);
    const replay = await store.consume(issued.ticket);
    assert.equal(first?.userId, "user-1");
    assert.equal(first?.sessionId, "session-1");
    assert.equal(replay, null);

    now += 31_000;
    const expired = await store.issue({
      userId: "user-2",
      sessionId: "session-2",
    });
    now += 31_000;
    assert.equal(await store.consume(expired.ticket), null);
  });

  it("按 lastSequence 仅补发断线期间缺失的消息", async () => {
    const store = new RoomSnapshotStore({
      runtime: createMemoryRedisRuntime(),
    });
    await store.saveSnapshot({
      roomId: "room-1",
      status: "active",
      participantIds: ["user-a", "user-b"],
      opponentType: "human",
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    for (let index = 1; index <= 3; index += 1) {
      const message = await store.appendMessage("room-1", {
        id: `message-${index}`,
        senderId: index % 2 === 0 ? "user-b" : "user-a",
        text: `第 ${index} 条`,
        at: 1_000 + index,
      });
      assert.equal(message.sequence, index);
    }

    const bundle = await store.getResumeBundle("room-1", 1);
    assert.ok(bundle);
    assert.deepEqual(
      bundle.messages.map((message) => message.sequence),
      [2, 3],
    );
    assert.equal(bundle.snapshot.lastSequence, 3);
    assert.equal(bundle.hasGap, false);
  });
});
