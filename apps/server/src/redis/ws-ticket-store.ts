import { randomBytes } from "node:crypto";
import type { RedisRuntime } from "./client.js";
import {
  createMemoryRedisRuntime,
  getRuntimeMemoryState,
} from "./client.js";
import { RedisKeys } from "./keys.js";

export interface WsTicketPayload {
  userId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

interface MemoryTicketRecord {
  payload: WsTicketPayload;
  expiresAt: number;
}

export interface WsTicketStoreOptions {
  runtime?: RedisRuntime;
  keys?: RedisKeys;
  now?: () => number;
  ttlMs?: number;
}

const CONSUME_TICKET_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then
  return nil
end
redis.call("DEL", KEYS[1])
return value
`;

/**
 * WebSocket 握手票据只保存会话引用，消费成功后立即删除，防止重放。
 */
export class WsTicketStore {
  private readonly runtime: RedisRuntime;
  private readonly keys: RedisKeys;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly memory: Map<string, MemoryTicketRecord>;

  constructor(options: WsTicketStoreOptions = {}) {
    this.runtime = options.runtime ?? createMemoryRedisRuntime();
    this.keys = options.keys ?? new RedisKeys();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.memory = this.runtime.memory
      ? getRuntimeMemoryState(
          this.runtime,
          "ws-ticket-store",
          () => new Map<string, MemoryTicketRecord>(),
        )
      : new Map();
  }

  async issue(
    input: Pick<WsTicketPayload, "userId" | "sessionId">,
  ): Promise<{ ticket: string; expiresAt: number }> {
    const ticket = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const payload: WsTicketPayload = {
      ...input,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    if (this.runtime.client) {
      await this.runtime.client.call(
        "SET",
        this.keys.wsTicket(ticket),
        JSON.stringify(payload),
        "PX",
        this.ttlMs,
        "NX",
      );
    } else {
      this.memory.set(ticket, { payload, expiresAt: payload.expiresAt });
    }
    return { ticket, expiresAt: payload.expiresAt };
  }

  async consume(ticket: string): Promise<WsTicketPayload | null> {
    if (!ticket) {
      return null;
    }
    let payload: WsTicketPayload | null;
    if (this.runtime.client) {
      const raw = await this.runtime.client.eval(
        CONSUME_TICKET_SCRIPT,
        [this.keys.wsTicket(ticket)],
        [],
      );
      payload = typeof raw === "string" ? this.parsePayload(raw) : null;
    } else {
      const record = this.memory.get(ticket);
      this.memory.delete(ticket);
      payload = record?.payload ?? null;
    }

    if (!payload || payload.expiresAt <= this.now()) {
      return null;
    }
    return payload;
  }

  private parsePayload(raw: string): WsTicketPayload | null {
    try {
      const parsed = JSON.parse(raw) as Partial<WsTicketPayload>;
      if (
        typeof parsed.userId !== "string" ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.issuedAt !== "number" ||
        typeof parsed.expiresAt !== "number"
      ) {
        return null;
      }
      return parsed as WsTicketPayload;
    } catch {
      return null;
    }
  }
}
