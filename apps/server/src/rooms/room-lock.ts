import { randomUUID } from "node:crypto";
import type { RedisRuntime } from "../redis/client.js";
import {
  createMemoryRedisRuntime,
  getRuntimeMemoryState,
} from "../redis/client.js";
import { RedisKeys } from "../redis/keys.js";

export interface RoomLockOptions {
  runtime?: RedisRuntime;
  keys?: RedisKeys;
  leaseMs?: number;
  waitTimeoutMs?: number;
  retryMs?: number;
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export class RoomLockTimeoutError extends Error {
  constructor(readonly roomId: string) {
    super(`等待房间 ${roomId} 的写锁超时。`);
    this.name = "RoomLockTimeoutError";
  }
}

/**
 * 判断提交、结算与重连恢复应通过同一房间锁串行执行。
 */
export class RoomLock {
  private readonly runtime: RedisRuntime;
  private readonly keys: RedisKeys;
  private readonly leaseMs: number;
  private readonly waitTimeoutMs: number;
  private readonly retryMs: number;
  private readonly memoryLocks: Map<string, Promise<void>>;

  constructor(options: RoomLockOptions = {}) {
    this.runtime = options.runtime ?? createMemoryRedisRuntime();
    this.keys = options.keys ?? new RedisKeys();
    this.leaseMs = options.leaseMs ?? 5_000;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 1_000;
    this.retryMs = options.retryMs ?? 25;
    this.memoryLocks = this.runtime.memory
      ? getRuntimeMemoryState(
          this.runtime,
          "room-locks",
          () => new Map<string, Promise<void>>(),
        )
      : new Map();
  }

  async runExclusive<T>(
    roomId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.runtime.client) {
      return this.runMemoryExclusive(roomId, operation);
    }

    const token = randomUUID();
    const key = this.keys.roomLock(roomId);
    const deadline = Date.now() + this.waitTimeoutMs;
    while (true) {
      const acquired = await this.runtime.client.call(
        "SET",
        key,
        token,
        "PX",
        this.leaseMs,
        "NX",
      );
      if (acquired === "OK") break;
      if (Date.now() >= deadline) {
        throw new RoomLockTimeoutError(roomId);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.retryMs));
    }

    try {
      return await operation();
    } finally {
      await this.runtime.client.eval(RELEASE_LOCK_SCRIPT, [key], [token]);
    }
  }

  private async runMemoryExclusive<T>(
    roomId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.memoryLocks.get(roomId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.memoryLocks.set(roomId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.memoryLocks.get(roomId) === current) {
        this.memoryLocks.delete(roomId);
      }
    }
  }
}
