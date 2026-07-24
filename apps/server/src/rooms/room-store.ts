import type { RedisRuntime } from "../redis/client.js";
import {
  createMemoryRedisRuntime,
  getRuntimeMemoryState,
} from "../redis/client.js";
import { RedisKeys } from "../redis/keys.js";

export interface RoomSnapshot {
  roomId: string;
  status: string;
  participantIds: string[];
  opponentType: "human" | "ai";
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  lastSequence: number;
  metadata?: Record<string, unknown>;
}

export type RoomSnapshotInput = Omit<
  RoomSnapshot,
  "updatedAt" | "lastSequence"
> &
  Partial<Pick<RoomSnapshot, "updatedAt" | "lastSequence">>;

export interface RoomMessageInput {
  id: string;
  senderId: string;
  text: string;
  at: number;
  metadata?: Record<string, unknown>;
}

export interface SequencedRoomMessage extends RoomMessageInput {
  sequence: number;
}

export interface RoomResumeBundle {
  snapshot: RoomSnapshot;
  messages: SequencedRoomMessage[];
  hasGap: boolean;
}

export interface RoomSnapshotStoreOptions {
  runtime?: RedisRuntime;
  keys?: RedisKeys;
  now?: () => number;
  ttlMs?: number;
  maxMessages?: number;
}

interface MemoryRoomRecord {
  snapshot?: RoomSnapshot;
  messages: SequencedRoomMessage[];
  sequence: number;
  expiresAt: number;
}

const APPEND_MESSAGE_SCRIPT = `
local sequence = redis.call("INCR", KEYS[1])
local message = cjson.decode(ARGV[1])
message["sequence"] = sequence
local encoded = cjson.encode(message)
redis.call("RPUSH", KEYS[2], encoded)
redis.call("LTRIM", KEYS[2], -tonumber(ARGV[2]), -1)
redis.call("PEXPIRE", KEYS[1], ARGV[3])
redis.call("PEXPIRE", KEYS[2], ARGV[3])
return encoded
`;

/**
 * 房间快照与消息日志分开保存。消息 sequence 在存储侧原子递增，
 * 客户端可用 lastSequence 只补发缺失消息。
 */
export class RoomSnapshotStore {
  private readonly runtime: RedisRuntime;
  private readonly keys: RedisKeys;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxMessages: number;
  private readonly memoryRooms: Map<string, MemoryRoomRecord>;

  constructor(options: RoomSnapshotStoreOptions = {}) {
    this.runtime = options.runtime ?? createMemoryRedisRuntime();
    this.keys = options.keys ?? new RedisKeys();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.maxMessages = options.maxMessages ?? 500;
    this.memoryRooms = this.runtime.memory
      ? getRuntimeMemoryState(
          this.runtime,
          "room-snapshot-store",
          () => new Map<string, MemoryRoomRecord>(),
        )
      : new Map();
  }

  async saveSnapshot(input: RoomSnapshotInput): Promise<RoomSnapshot> {
    const latestSequence = await this.getCurrentSequence(input.roomId);
    const snapshot: RoomSnapshot = {
      ...input,
      updatedAt: this.now(),
      lastSequence: Math.max(input.lastSequence ?? 0, latestSequence),
    };
    if (this.runtime.client) {
      await this.runtime.client.call(
        "SET",
        this.keys.roomSnapshot(input.roomId),
        JSON.stringify(snapshot),
        "PX",
        this.ttlMs,
      );
    } else {
      const record = this.getOrCreateMemoryRoom(input.roomId);
      record.snapshot = snapshot;
      record.expiresAt = this.now() + this.ttlMs;
    }
    return snapshot;
  }

  async getSnapshot(roomId: string): Promise<RoomSnapshot | null> {
    if (this.runtime.client) {
      const raw = await this.runtime.client.call(
        "GET",
        this.keys.roomSnapshot(roomId),
      );
      return typeof raw === "string" ? this.parseSnapshot(raw) : null;
    }
    const record = this.getLiveMemoryRoom(roomId);
    return record?.snapshot ?? null;
  }

  async appendMessage(
    roomId: string,
    input: RoomMessageInput,
  ): Promise<SequencedRoomMessage> {
    if (this.runtime.client) {
      const raw = await this.runtime.client.eval(
        APPEND_MESSAGE_SCRIPT,
        [this.keys.roomSequence(roomId), this.keys.roomMessages(roomId)],
        [JSON.stringify(input), this.maxMessages, this.ttlMs],
      );
      if (typeof raw !== "string") {
        throw new Error("Redis 未返回有效的房间消息。");
      }
      const parsed = this.parseMessage(raw);
      if (!parsed) {
        throw new Error("Redis 返回的房间消息格式无效。");
      }
      return parsed;
    }

    const record = this.getOrCreateMemoryRoom(roomId);
    record.sequence += 1;
    const message: SequencedRoomMessage = {
      ...input,
      sequence: record.sequence,
    };
    record.messages.push(message);
    if (record.messages.length > this.maxMessages) {
      record.messages.splice(0, record.messages.length - this.maxMessages);
    }
    record.expiresAt = this.now() + this.ttlMs;
    if (record.snapshot) {
      record.snapshot.lastSequence = record.sequence;
      record.snapshot.updatedAt = this.now();
    }
    return message;
  }

  async replayMessages(
    roomId: string,
    afterSequence: number,
    limit = 200,
  ): Promise<SequencedRoomMessage[]> {
    const safeSequence = Math.max(0, Math.floor(afterSequence));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), this.maxMessages);
    let messages: SequencedRoomMessage[];
    if (this.runtime.client) {
      const raw = await this.runtime.client.call(
        "LRANGE",
        this.keys.roomMessages(roomId),
        -this.maxMessages,
        -1,
      );
      messages = Array.isArray(raw)
        ? raw
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => this.parseMessage(entry))
            .filter(
              (message): message is SequencedRoomMessage => message !== null,
            )
        : [];
    } else {
      messages = this.getLiveMemoryRoom(roomId)?.messages ?? [];
    }
    return messages
      .filter((message) => message.sequence > safeSequence)
      .slice(0, safeLimit);
  }

  async getResumeBundle(
    roomId: string,
    afterSequence: number,
    limit = 200,
  ): Promise<RoomResumeBundle | null> {
    const [snapshot, messages, currentSequence] = await Promise.all([
      this.getSnapshot(roomId),
      this.replayMessages(roomId, afterSequence, limit),
      this.getCurrentSequence(roomId),
    ]);
    if (!snapshot) {
      return null;
    }
    return {
      snapshot: {
        ...snapshot,
        lastSequence: Math.max(
          snapshot.lastSequence,
          currentSequence,
          messages.at(-1)?.sequence ?? 0,
        ),
      },
      messages,
      hasGap:
        (messages.length > 0 &&
          messages[0]?.sequence !== afterSequence + 1) ||
        (messages.length === 0 && currentSequence > afterSequence),
    };
  }

  async deleteRoom(roomId: string): Promise<void> {
    if (this.runtime.client) {
      await this.runtime.client.call(
        "DEL",
        this.keys.roomSnapshot(roomId),
        this.keys.roomMessages(roomId),
        this.keys.roomSequence(roomId),
      );
      return;
    }
    this.memoryRooms.delete(roomId);
  }

  private async getCurrentSequence(roomId: string): Promise<number> {
    if (this.runtime.client) {
      const raw = await this.runtime.client.call(
        "GET",
        this.keys.roomSequence(roomId),
      );
      const sequence = Number(raw);
      return Number.isFinite(sequence) ? sequence : 0;
    }
    return this.getLiveMemoryRoom(roomId)?.sequence ?? 0;
  }

  private getOrCreateMemoryRoom(roomId: string): MemoryRoomRecord {
    const existing = this.getLiveMemoryRoom(roomId);
    if (existing) return existing;
    const created: MemoryRoomRecord = {
      messages: [],
      sequence: 0,
      expiresAt: this.now() + this.ttlMs,
    };
    this.memoryRooms.set(roomId, created);
    return created;
  }

  private getLiveMemoryRoom(roomId: string): MemoryRoomRecord | null {
    const record = this.memoryRooms.get(roomId);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.memoryRooms.delete(roomId);
      return null;
    }
    return record;
  }

  private parseSnapshot(raw: string): RoomSnapshot | null {
    try {
      const snapshot = JSON.parse(raw) as Partial<RoomSnapshot>;
      if (
        typeof snapshot.roomId !== "string" ||
        typeof snapshot.status !== "string" ||
        !Array.isArray(snapshot.participantIds) ||
        (snapshot.opponentType !== "human" && snapshot.opponentType !== "ai") ||
        typeof snapshot.createdAt !== "number" ||
        typeof snapshot.expiresAt !== "number" ||
        typeof snapshot.updatedAt !== "number" ||
        typeof snapshot.lastSequence !== "number"
      ) {
        return null;
      }
      return snapshot as RoomSnapshot;
    } catch {
      return null;
    }
  }

  private parseMessage(raw: string): SequencedRoomMessage | null {
    try {
      const message = JSON.parse(raw) as Partial<SequencedRoomMessage>;
      if (
        typeof message.id !== "string" ||
        typeof message.senderId !== "string" ||
        typeof message.text !== "string" ||
        typeof message.at !== "number" ||
        typeof message.sequence !== "number"
      ) {
        return null;
      }
      return message as SequencedRoomMessage;
    } catch {
      return null;
    }
  }
}
