import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { WebSocket } from "ws";
import {
  AI_USAGE_ESTIMATED_TOKENS,
  ENTRY_GATE_MS,
  GUESS_UNLOCK_MS,
  GameService,
  type GameServiceOptions,
} from "../src/game.js";
import type {
  AiReserveDecision,
  AiReserveRequest,
  AiSettleRequest,
  AiSettleResult,
  AiUsageReservation,
} from "../src/ai/usage-budget.js";
import type { Session } from "../src/types.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<{ type: string; [key: string]: unknown }> = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as never);
  }
}

interface TimerRecord {
  id: number;
  at: number;
  callback: () => void;
  cancelled: boolean;
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers: TimerRecord[] = [];
  return {
    now: () => now,
    setTimer(callback: () => void, milliseconds: number) {
      const timer = {
        id: nextId++,
        at: now + milliseconds,
        callback,
        cancelled: false,
      };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer(timer: NodeJS.Timeout) {
      (timer as unknown as TimerRecord).cancelled = true;
    },
    advance(milliseconds: number) {
      const end = now + milliseconds;
      while (true) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        due.cancelled = true;
        now = due.at;
        due.callback();
      }
      now = end;
    },
  };
}

function session(id: string): {
  session: Session;
  socket: FakeSocket;
} {
  const socket = new FakeSocket();
  return {
    socket,
    session: {
      sessionId: `session-${id}`,
      tokenHash: `hash-${id}`,
      userId: id,
      ipHash: "hashed-loopback",
      deviceId: `device-${id}`,
      csrfHash: `csrf-${id}`,
      createdAt: 0,
      lastSeenAt: 0,
      idleExpiresAt: Number.MAX_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER,
      profile: { nickname: `玩家${id}`, typingStatus: "正在想…" },
      socket: socket as unknown as WebSocket,
    },
  };
}

class RecordingAiUsageBudget {
  readonly reserves: AiReserveRequest[] = [];
  readonly settlements: AiSettleRequest[] = [];
  allow = true;
  private readonly reservations = new Map<string, AiUsageReservation>();

  async reserve(request: AiReserveRequest): Promise<AiReserveDecision> {
    this.reserves.push(request);
    if (!this.allow) {
      return {
        allowed: false,
        idempotentReplay: false,
        exceeded: [],
        retryAfterMs: 1_000,
      };
    }
    const reservation: AiUsageReservation = {
      id: request.reservationId,
      identity: { ...request.identity },
      estimatedTokens: request.estimatedTokens,
      reservedAt: request.now ?? 0,
      state: "reserved",
    };
    this.reservations.set(request.reservationId, reservation);
    return {
      allowed: true,
      reservation,
      idempotentReplay: false,
      exceeded: [],
    };
  }

  async settle(request: AiSettleRequest): Promise<AiSettleResult> {
    this.settlements.push(request);
    const reservation = this.reservations.get(request.reservationId);
    assert.ok(reservation);
    return {
      reservation: {
        ...reservation,
        state: "settled",
        settledAt: request.now ?? 0,
        outcome: request.outcome,
        promptTokens: request.promptTokens,
        completionTokens: request.completionTokens,
      },
      idempotentReplay: false,
      overageTokens: 0,
      exceededAfterSettle: [],
    };
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: GameServiceOptions = {}) {
  const clock = fakeClock();
  const service = new GameService({
    now: clock.now,
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    aiReply: async () => "AI 回复",
    ...options,
  });
  return { service, clock };
}

describe("匹配与结算规则", () => {
  it("AI 和真人对局都不能绕过每位玩家的五秒入场门", () => {
    const { service, clock } = harness();
    const a = session("a");
    service.joinQueue(a.session);
    clock.advance(ENTRY_GATE_MS - 1);
    assert.equal(a.socket.sent.some((event) => event.type === "match.found"), false);
    clock.advance(1);
    assert.equal(a.socket.sent.some((event) => event.type === "match.found"), true);

    const { service: humanService, clock: humanClock } = harness();
    const b = session("b");
    const c = session("c");
    humanService.joinQueue(b.session);
    humanClock.advance(2_000);
    humanService.joinQueue(c.session);
    humanClock.advance(4_999);
    assert.equal(b.socket.sent.some((event) => event.type === "match.found"), false);
    humanClock.advance(1);
    assert.equal(b.socket.sent.some((event) => event.type === "match.found"), true);
    assert.equal(c.socket.sent.some((event) => event.type === "match.found"), true);
  });

  it("AI 局锁定判断后取消 AI 回复并立即结算", () => {
    const { service, clock } = harness();
    const player = session("a");
    service.joinQueue(player.session);
    clock.advance(ENTRY_GATE_MS);
    clock.advance(GUESS_UNLOCK_MS);
    service.sendChat(player.session, "你是谁？");
    service.submitGuess(player.session, "ai");

    const room = service.rooms.get(player.session.roomId ?? "");
    assert.equal(room?.status, "settled");
    assert.equal(room?.aiAbort, undefined);
    const settled = player.socket.sent.find(
      (event) => event.type === "game.finished",
    );
    assert.equal(settled?.opponentType, "ai");
    assert.equal(settled?.isCorrect, true);
  });

  it("真人局等待双方判断，且不广播 opponent.guessed", () => {
    const { service, clock } = harness();
    const a = session("a");
    const b = session("b");
    service.joinQueue(a.session);
    service.joinQueue(b.session);
    clock.advance(ENTRY_GATE_MS);
    clock.advance(GUESS_UNLOCK_MS);

    service.submitGuess(a.session, "human");
    const room = service.rooms.get(a.session.roomId ?? "");
    assert.equal(room?.status, "active");
    assert.equal(
      b.socket.sent.some((event) => event.type === "opponent.guessed"),
      false,
    );

    service.submitGuess(b.session, "human");
    assert.equal(room?.status, "settled");
    assert.equal(
      a.socket.sent.some((event) => event.type === "game.finished"),
      true,
    );
    assert.equal(
      b.socket.sent.some((event) => event.type === "game.finished"),
      true,
    );
  });

  it("联系方式会被替换，高风险威胁会终止对局", () => {
    const { service, clock } = harness();
    const a = session("a");
    const b = session("b");
    service.joinQueue(a.session);
    service.joinQueue(b.session);
    clock.advance(ENTRY_GATE_MS);

    service.sendChat(a.session, "加我微信: abcdef123");
    const redacted = b.socket.sent.find(
      (event) => event.type === "chat.message",
    );
    assert.equal(
      String(redacted?.content).includes("[联系方式已隐藏]"),
      true,
    );
    assert.equal(String(redacted?.content).includes("abcdef123"), false);

    assert.throws(
      () => service.sendChat(a.session, "我今晚要杀了你"),
      /高风险内容/u,
    );
    const room = service.rooms.get(a.session.roomId ?? "");
    assert.equal(room?.status, "settled");
    assert.equal(
      b.socket.sent.some(
        (event) =>
          event.type === "chat.message" &&
          String(event.content).includes("杀了你"),
      ),
      false,
    );
  });

  it("AI 回复按房间、用户、设备、IP 和全局预算预留并成功结算", async () => {
    const budget = new RecordingAiUsageBudget();
    const { service, clock } = harness({ aiUsageBudget: budget });
    const player = session("budget-success");
    service.joinQueue(player.session);
    clock.advance(ENTRY_GATE_MS);

    service.sendChat(player.session, "你好");
    clock.advance(500);
    await flushAsync();
    await flushAsync();

    assert.equal(budget.reserves.length, 1);
    const reservation = budget.reserves[0];
    assert.ok(reservation);
    assert.deepEqual(reservation.identity, {
      roomId: player.session.roomId,
      userId: player.session.userId,
      deviceId: player.session.deviceId,
      ip: player.session.ipHash,
    });
    assert.equal(
      reservation.estimatedTokens,
      AI_USAGE_ESTIMATED_TOKENS,
    );
    assert.equal(budget.settlements.length, 1);
    assert.equal(budget.settlements[0]?.outcome, "success");
    assert.equal(
      (budget.settlements[0]?.promptTokens ?? 0) +
        (budget.settlements[0]?.completionTokens ?? 0) <=
        AI_USAGE_ESTIMATED_TOKENS,
      true,
    );
  });

  it("AI 预算拒绝时不调用模型，也不产生无效结算", async () => {
    const budget = new RecordingAiUsageBudget();
    budget.allow = false;
    let calls = 0;
    const { service, clock } = harness({
      aiUsageBudget: budget,
      aiReply: async () => {
        calls += 1;
        return "不应调用";
      },
    });
    const player = session("budget-rejected");
    service.joinQueue(player.session);
    clock.advance(ENTRY_GATE_MS);

    service.sendChat(player.session, "你好");
    clock.advance(500);
    await flushAsync();

    assert.equal(budget.reserves.length, 1);
    assert.equal(calls, 0);
    assert.equal(budget.settlements.length, 0);
    assert.equal(
      player.socket.sent.some(
        (event) =>
          event.type === "game.error" && event.code === "AI_UNAVAILABLE",
      ),
      true,
    );
  });

  it("AI 调用失败按 failed 结算，取消中的调用按 cancelled 结算", async () => {
    const failedBudget = new RecordingAiUsageBudget();
    const failedHarness = harness({
      aiUsageBudget: failedBudget,
      aiReply: async () => {
        throw new Error("provider unavailable");
      },
    });
    const failedPlayer = session("budget-failed");
    failedHarness.service.joinQueue(failedPlayer.session);
    failedHarness.clock.advance(ENTRY_GATE_MS);
    failedHarness.service.sendChat(failedPlayer.session, "失败路径");
    failedHarness.clock.advance(500);
    await flushAsync();
    await flushAsync();

    assert.equal(failedBudget.settlements[0]?.outcome, "failed");
    assert.equal(
      failedBudget.settlements[0]?.promptTokens,
      AI_USAGE_ESTIMATED_TOKENS,
    );

    const cancelledBudget = new RecordingAiUsageBudget();
    let aiStarted = false;
    const cancelledHarness = harness({
      aiUsageBudget: cancelledBudget,
      aiReply: async ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          aiStarted = true;
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    const cancelledPlayer = session("budget-cancelled");
    cancelledHarness.service.joinQueue(cancelledPlayer.session);
    cancelledHarness.clock.advance(ENTRY_GATE_MS);
    cancelledHarness.service.sendChat(cancelledPlayer.session, "取消路径");
    cancelledHarness.clock.advance(500);
    await flushAsync();
    assert.equal(aiStarted, true);

    cancelledHarness.clock.advance(GUESS_UNLOCK_MS - 500);
    cancelledHarness.service.submitGuess(cancelledPlayer.session, "ai");
    await flushAsync();
    await flushAsync();

    assert.equal(cancelledBudget.settlements.length, 1);
    assert.equal(cancelledBudget.settlements[0]?.outcome, "cancelled");
    assert.equal(
      cancelledBudget.settlements[0]?.promptTokens,
      AI_USAGE_ESTIMATED_TOKENS,
    );
  });
});
