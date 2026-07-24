export type RedisRuntimeMode = "memory" | "redis";

export interface RedisCommandClient {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
  eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown>;
}

export interface RedisHealth {
  mode: RedisRuntimeMode;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface RedisRuntime {
  readonly mode: RedisRuntimeMode;
  readonly client: RedisCommandClient | null;
  readonly memory: Map<string, unknown> | null;
  health(): Promise<RedisHealth>;
  close(): Promise<void>;
}

export interface CreateRedisRuntimeOptions {
  url?: string;
  connectTimeoutMs?: number;
}

interface RawRedisClient {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  connect(): Promise<void>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

type RedisConstructor = new (
  url: string,
  options: Record<string, unknown>,
) => RawRedisClient;

class MemoryRedisRuntime implements RedisRuntime {
  readonly mode = "memory" as const;
  readonly client = null;
  readonly memory = new Map<string, unknown>();

  async health(): Promise<RedisHealth> {
    return { mode: this.mode, ok: true, latencyMs: 0 };
  }

  async close(): Promise<void> {
    // 内存运行时没有外部连接。
  }
}

class IoredisRuntime implements RedisRuntime {
  readonly mode = "redis" as const;
  readonly client: RedisCommandClient;
  readonly memory = null;

  constructor(private readonly rawClient: RawRedisClient) {
    this.client = {
      call: (command, ...args) => rawClient.call(command, ...args),
      eval: (script, keys, args) =>
        rawClient.eval(script, keys.length, ...keys, ...args),
    };
  }

  async health(): Promise<RedisHealth> {
    const startedAt = Date.now();
    try {
      const pong = await this.rawClient.call("PING");
      return {
        mode: this.mode,
        ok: pong === "PONG",
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        mode: this.mode,
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Redis 健康检查失败",
      };
    }
  }

  async close(): Promise<void> {
    try {
      await this.rawClient.quit();
    } catch {
      this.rawClient.disconnect();
    }
  }
}

/**
 * 显式创建进程内运行时，供本地开发、单元测试和 Redis 降级路径使用。
 */
export function createMemoryRedisRuntime(): RedisRuntime {
  return new MemoryRedisRuntime();
}

/**
 * 让同一内存运行时下的多个 Store 实例共享状态，贴近 Redis 多消费者语义。
 */
export function getRuntimeMemoryState<T>(
  runtime: RedisRuntime,
  key: string,
  create: () => T,
): T {
  if (!runtime.memory) {
    throw new Error("Redis 运行时不能访问进程内状态。");
  }
  const existing = runtime.memory.get(key);
  if (existing !== undefined) {
    return existing as T;
  }
  const value = create();
  runtime.memory.set(key, value);
  return value;
}

/**
 * 仅在配置 REDIS_URL 时加载 ioredis。没有配置时不会导入可选依赖。
 */
export async function createRedisRuntime(
  options: CreateRedisRuntimeOptions = {},
): Promise<RedisRuntime> {
  const url = options.url ?? process.env.REDIS_URL;
  if (!url) {
    return createMemoryRedisRuntime();
  }

  // 使用运行时导入，使本地无 ioredis 依赖时仍可编译并执行内存实现。
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<{ default?: RedisConstructor }>;
  let Redis: RedisConstructor | undefined;
  try {
    const module = await dynamicImport("ioredis");
    Redis = module.default;
  } catch {
    throw new Error(
      "检测到 REDIS_URL，但尚未安装 ioredis。请安装依赖后再启动服务。",
    );
  }
  if (!Redis) {
    throw new Error("ioredis 模块未导出可用的 Redis 构造函数。");
  }

  const rawClient = new Redis(url, {
    lazyConnect: true,
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  try {
    await rawClient.connect();
  } catch (error) {
    rawClient.disconnect();
    throw error;
  }
  return new IoredisRuntime(rawClient);
}
