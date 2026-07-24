import { randomUUID } from "node:crypto";
import type { RedisRuntime } from "../redis/client.js";
import {
  createMemoryRedisRuntime,
  getRuntimeMemoryState,
} from "../redis/client.js";
import { RedisKeys } from "../redis/keys.js";
import { AiBudgetController } from "./ai-budget.js";

export const ADMISSION_GATE_MS = 5_000;
const ADMISSION_TICKET_TTL_MS = 2 * 60_000;
const ADMISSION_LOCK_MS = 3_000;

export interface AdmissionPlayer {
  userId: string;
  sessionId: string;
}

export interface AdmissionTicket extends AdmissionPlayer {
  id: string;
  joinedAt: number;
  gateEndsAt: number;
  bucketId: string;
}

export type MatchAssignment =
  | {
      kind: "human";
      playerIds: [string, string];
      matchedAt: number;
      bucketId: string;
    }
  | {
      kind: "ai";
      playerIds: [string];
      matchedAt: number;
      bucketId: string;
    }
  | {
      kind: "waiting";
      playerIds: [string];
      matchedAt: null;
      bucketId: string;
      reason: "human_pending" | "ai_budget_exhausted";
      retryAt: number;
    };

export interface AdmissionServiceOptions {
  runtime?: RedisRuntime;
  keys?: RedisKeys;
  aiBudget?: AiBudgetController;
  now?: () => number;
  gateMs?: number;
}

interface MemoryAdmissionState {
  tickets: Map<string, AdmissionTicket>;
  lock: Promise<void>;
}

const JOIN_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
return 1
`;

const REMOVE_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
return 1
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * 每位玩家都有完整五秒入场门。门结束后批量处理全部到期玩家：
 * 真人两两优先，剩余玩家只有在没有其他真人即将到期时才考虑 AI。
 */
export class AdmissionService {
  private readonly runtime: RedisRuntime;
  private readonly keys: RedisKeys;
  private readonly aiBudget: AiBudgetController;
  private readonly now: () => number;
  private readonly gateMs: number;
  private readonly memoryState: MemoryAdmissionState;

  constructor(options: AdmissionServiceOptions = {}) {
    this.runtime = options.runtime ?? createMemoryRedisRuntime();
    this.keys = options.keys ?? new RedisKeys();
    this.aiBudget =
      options.aiBudget ??
      new AiBudgetController({ runtime: this.runtime, keys: this.keys });
    this.now = options.now ?? Date.now;
    this.gateMs = options.gateMs ?? ADMISSION_GATE_MS;
    this.memoryState = this.runtime.memory
      ? getRuntimeMemoryState(this.runtime, "admission-state", () => ({
          tickets: new Map<string, AdmissionTicket>(),
          lock: Promise.resolve(),
        }))
      : { tickets: new Map(), lock: Promise.resolve() };
  }

  async joinAdmission(player: AdmissionPlayer): Promise<AdmissionTicket> {
    if (!player.userId || !player.sessionId) {
      throw new Error("入场玩家必须包含 userId 和 sessionId。");
    }
    const existing = await this.findTicket(player.userId);
    if (existing) {
      return existing;
    }

    const joinedAt = this.now();
    const gateEndsAt = joinedAt + this.gateMs;
    const ticket: AdmissionTicket = {
      ...player,
      id: randomUUID(),
      joinedAt,
      gateEndsAt,
      bucketId: Math.floor(gateEndsAt / this.gateMs).toString(36),
    };

    if (this.runtime.client) {
      const created = await this.runtime.client.eval(
        JOIN_SCRIPT,
        [
          this.keys.admissionTicket(player.userId),
          this.keys.admissionQueue(),
        ],
        [
          JSON.stringify(ticket),
          ADMISSION_TICKET_TTL_MS,
          ticket.gateEndsAt,
          player.userId,
        ],
      );
      if (Number(created) !== 1) {
        return (await this.findTicket(player.userId)) ?? ticket;
      }
    } else {
      this.memoryState.tickets.set(player.userId, ticket);
    }
    return ticket;
  }

  async cancelAdmission(userId: string): Promise<void> {
    if (this.runtime.client) {
      await this.runtime.client.eval(
        REMOVE_SCRIPT,
        [
          this.keys.admissionQueue(),
          this.keys.admissionTicket(userId),
        ],
        [userId],
      );
      return;
    }
    this.memoryState.tickets.delete(userId);
  }

  /**
   * bucketId 用于让调用方关联本轮调度；调度时会处理全部已到期玩家，
   * 从而允许相邻入场批次之间形成真人对局。
   */
  async finalizeAdmission(bucketId: string): Promise<MatchAssignment[]> {
    return this.withLock(async () => {
      const now = this.now();
      const tickets = (await this.listTickets()).sort(
        (left, right) => left.joinedAt - right.joinedAt,
      );
      const eligible = tickets.filter((ticket) => ticket.gateEndsAt <= now);
      const pending = tickets.filter((ticket) => ticket.gateEndsAt > now);
      const assignments: MatchAssignment[] = [];

      while (eligible.length >= 2) {
        const first = eligible.shift();
        const second = eligible.shift();
        if (!first || !second) break;
        await this.removeTickets([first.userId, second.userId]);
        await this.aiBudget.recordHumanGame();
        assignments.push({
          kind: "human",
          playerIds: [first.userId, second.userId],
          matchedAt: now,
          bucketId,
        });
      }

      const remaining = eligible[0];
      if (!remaining) {
        return assignments;
      }
      if (pending.length > 0) {
        assignments.push({
          kind: "waiting",
          playerIds: [remaining.userId],
          matchedAt: null,
          bucketId,
          reason: "human_pending",
          retryAt: Math.min(...pending.map((ticket) => ticket.gateEndsAt)),
        });
        return assignments;
      }

      const decision = await this.aiBudget.reserveAiGame();
      if (!decision.allowed) {
        assignments.push({
          kind: "waiting",
          playerIds: [remaining.userId],
          matchedAt: null,
          bucketId,
          reason: "ai_budget_exhausted",
          retryAt: now + this.gateMs,
        });
        return assignments;
      }

      await this.removeTickets([remaining.userId]);
      assignments.push({
        kind: "ai",
        playerIds: [remaining.userId],
        matchedAt: now,
        bucketId,
      });
      return assignments;
    });
  }

  async listWaiting(): Promise<AdmissionTicket[]> {
    return this.listTickets();
  }

  private async findTicket(userId: string): Promise<AdmissionTicket | null> {
    if (!this.runtime.client) {
      return this.memoryState.tickets.get(userId) ?? null;
    }
    const raw = await this.runtime.client.call(
      "GET",
      this.keys.admissionTicket(userId),
    );
    return typeof raw === "string" ? this.parseTicket(raw) : null;
  }

  private async listTickets(): Promise<AdmissionTicket[]> {
    if (!this.runtime.client) {
      return [...this.memoryState.tickets.values()];
    }
    const members = await this.runtime.client.call(
      "ZRANGE",
      this.keys.admissionQueue(),
      0,
      -1,
    );
    if (!Array.isArray(members) || members.length === 0) {
      return [];
    }
    const userIds = members.filter(
      (member): member is string => typeof member === "string",
    );
    if (userIds.length === 0) {
      return [];
    }
    const rawTickets = await this.runtime.client.call(
      "MGET",
      ...userIds.map((userId) => this.keys.admissionTicket(userId)),
    );
    if (!Array.isArray(rawTickets)) {
      return [];
    }
    const tickets: AdmissionTicket[] = [];
    const staleUsers: string[] = [];
    rawTickets.forEach((raw, index) => {
      const userId = userIds[index];
      if (!userId) return;
      const ticket = typeof raw === "string" ? this.parseTicket(raw) : null;
      if (ticket) tickets.push(ticket);
      else staleUsers.push(userId);
    });
    if (staleUsers.length > 0) {
      await this.runtime.client.call(
        "ZREM",
        this.keys.admissionQueue(),
        ...staleUsers,
      );
    }
    return tickets;
  }

  private async removeTickets(userIds: string[]): Promise<void> {
    await Promise.all(userIds.map((userId) => this.cancelAdmission(userId)));
  }

  private parseTicket(raw: string): AdmissionTicket | null {
    try {
      const ticket = JSON.parse(raw) as Partial<AdmissionTicket>;
      if (
        typeof ticket.id !== "string" ||
        typeof ticket.userId !== "string" ||
        typeof ticket.sessionId !== "string" ||
        typeof ticket.joinedAt !== "number" ||
        typeof ticket.gateEndsAt !== "number" ||
        typeof ticket.bucketId !== "string"
      ) {
        return null;
      }
      return ticket as AdmissionTicket;
    } catch {
      return null;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.runtime.client) {
      const previous = this.memoryState.lock;
      let release = (): void => undefined;
      this.memoryState.lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    }

    const lockToken = randomUUID();
    const acquired = await this.runtime.client.call(
      "SET",
      this.keys.admissionLock(),
      lockToken,
      "PX",
      ADMISSION_LOCK_MS,
      "NX",
    );
    if (acquired !== "OK") {
      return [] as T;
    }
    try {
      return await operation();
    } finally {
      await this.runtime.client.eval(
        RELEASE_LOCK_SCRIPT,
        [this.keys.admissionLock()],
        [lockToken],
      );
    }
  }
}
