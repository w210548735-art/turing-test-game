const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type AiUsageDimension = "room" | "user" | "device" | "ip" | "global";
export type AiReservationState = "reserved" | "settled";
export type AiSettlementOutcome = "success" | "failed" | "cancelled";
export type AiBudgetMetric =
  | "concurrency"
  | "hourly_calls"
  | "daily_calls"
  | "hourly_tokens"
  | "daily_tokens";

export interface AiDimensionBudget {
  hourlyCalls: number;
  dailyCalls: number;
  hourlyTokens: number;
  dailyTokens: number;
}

export type AiUsageBudgetConfig = Readonly<
  Record<AiUsageDimension, AiDimensionBudget>
>;

/**
 * P0 安全起始值。正式值必须根据模型上下文长度、单价和供应商额度配置。
 * room 并发 1 是独立硬约束，不由这些次数值代替。
 */
export const DEFAULT_AI_USAGE_BUDGET: AiUsageBudgetConfig = {
  room: {
    hourlyCalls: 10,
    dailyCalls: 12,
    hourlyTokens: 20_000,
    dailyTokens: 24_000,
  },
  user: {
    hourlyCalls: 30,
    dailyCalls: 100,
    hourlyTokens: 60_000,
    dailyTokens: 200_000,
  },
  device: {
    hourlyCalls: 30,
    dailyCalls: 80,
    hourlyTokens: 60_000,
    dailyTokens: 160_000,
  },
  ip: {
    hourlyCalls: 100,
    dailyCalls: 500,
    hourlyTokens: 200_000,
    dailyTokens: 1_000_000,
  },
  global: {
    hourlyCalls: 1_000,
    dailyCalls: 10_000,
    hourlyTokens: 2_000_000,
    dailyTokens: 20_000_000,
  },
};

export interface AiUsageIdentity {
  roomId: string;
  userId: string;
  deviceId: string;
  ip: string;
}

export interface AiUsageReservation {
  id: string;
  identity: AiUsageIdentity;
  estimatedTokens: number;
  reservedAt: number;
  state: AiReservationState;
  settledAt?: number;
  outcome?: AiSettlementOutcome;
  promptTokens?: number;
  completionTokens?: number;
}

export interface AiBudgetExceeded {
  dimension: AiUsageDimension;
  metric: AiBudgetMetric;
  key: string;
  limit: number;
  current: number;
  requested: number;
  retryAfterMs: number;
}

export type AiReserveDecision =
  | {
      allowed: true;
      reservation: AiUsageReservation;
      idempotentReplay: boolean;
      exceeded: [];
    }
  | {
      allowed: false;
      idempotentReplay: false;
      exceeded: AiBudgetExceeded[];
      retryAfterMs: number;
    };

export interface AiReserveRequest {
  reservationId: string;
  identity: AiUsageIdentity;
  estimatedTokens: number;
  now?: number;
}

export interface AiSettleRequest {
  reservationId: string;
  outcome: AiSettlementOutcome;
  promptTokens: number;
  completionTokens: number;
  now?: number;
}

export interface AiSettleResult {
  reservation: AiUsageReservation;
  idempotentReplay: boolean;
  overageTokens: number;
  exceededAfterSettle: AiBudgetExceeded[];
}

interface ResolvedDimensionBudget {
  dimension: AiUsageDimension;
  key: string;
  budget: AiDimensionBudget;
}

export interface AiAtomicReserveRequest {
  reservationId: string;
  identity: AiUsageIdentity;
  estimatedTokens: number;
  now: number;
  dimensions: readonly ResolvedDimensionBudget[];
}

export interface AiAtomicSettleRequest {
  reservationId: string;
  outcome: AiSettlementOutcome;
  promptTokens: number;
  completionTokens: number;
  now: number;
}

/**
 * Redis/Lua 或数据库实现只需替换此仓储；两个操作都必须保证原子性。
 */
export interface AiUsageBudgetRepository {
  reserveAtomically(request: AiAtomicReserveRequest): Promise<AiReserveDecision>;
  settleAtomically(request: AiAtomicSettleRequest): Promise<AiSettleResult>;
}

export class AiUsageBudgetConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUsageBudgetConfigurationError";
  }
}

export class AiReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiReservationConflictError";
  }
}

export class AiReservationNotFoundError extends Error {
  constructor(reservationId: string) {
    super(`找不到 AI 用量 reservation：${reservationId}`);
    this.name = "AiReservationNotFoundError";
  }
}

interface TokenEvent {
  at: number;
  tokens: number;
}

interface UsageBucket {
  calls: number[];
  tokens: TokenEvent[];
  reservedTokens: Map<string, number>;
}

interface StoredReservation {
  public: AiUsageReservation;
  dimensions: ResolvedDimensionBudget[];
}

function cloneReservation(
  reservation: AiUsageReservation,
): AiUsageReservation {
  return {
    ...reservation,
    identity: { ...reservation.identity },
  };
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiUsageBudgetConfigurationError(`${label} 必须是正整数`);
  }
}

function validateNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AiUsageBudgetConfigurationError(`${label} 必须是非负整数`);
  }
}

function validateConfig(config: AiUsageBudgetConfig): void {
  for (const [dimension, budget] of Object.entries(config)) {
    validatePositiveInteger(budget.hourlyCalls, `${dimension}.hourlyCalls`);
    validatePositiveInteger(budget.dailyCalls, `${dimension}.dailyCalls`);
    validatePositiveInteger(budget.hourlyTokens, `${dimension}.hourlyTokens`);
    validatePositiveInteger(budget.dailyTokens, `${dimension}.dailyTokens`);
    if (budget.dailyCalls < budget.hourlyCalls) {
      throw new AiUsageBudgetConfigurationError(
        `${dimension}.dailyCalls 不能小于 hourlyCalls`,
      );
    }
    if (budget.dailyTokens < budget.hourlyTokens) {
      throw new AiUsageBudgetConfigurationError(
        `${dimension}.dailyTokens 不能小于 hourlyTokens`,
      );
    }
  }
}

function safeSegment(value: string): string {
  return encodeURIComponent(value.normalize("NFKC"));
}

function sameIdentity(left: AiUsageIdentity, right: AiUsageIdentity): boolean {
  return (
    left.roomId === right.roomId &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.ip === right.ip
  );
}

function sameSettlement(
  reservation: AiUsageReservation,
  request: AiAtomicSettleRequest,
): boolean {
  return (
    reservation.outcome === request.outcome &&
    reservation.promptTokens === request.promptTokens &&
    reservation.completionTokens === request.completionTokens
  );
}

/**
 * 单进程实现依赖 JavaScript 同步临界区：方法在首次 await 前完成全部检查和写入。
 */
export class MemoryAiUsageBudgetRepository
  implements AiUsageBudgetRepository
{
  private readonly buckets = new Map<string, UsageBucket>();
  private readonly reservations = new Map<string, StoredReservation>();
  private readonly activeRooms = new Map<string, string>();

  async reserveAtomically(
    request: AiAtomicReserveRequest,
  ): Promise<AiReserveDecision> {
    const existing = this.reservations.get(request.reservationId);
    if (existing) {
      if (
        existing.public.estimatedTokens !== request.estimatedTokens ||
        !sameIdentity(existing.public.identity, request.identity)
      ) {
        throw new AiReservationConflictError(
          `reservation ${request.reservationId} 已绑定到不同请求`,
        );
      }
      return {
        allowed: true,
        reservation: cloneReservation(existing.public),
        idempotentReplay: true,
        exceeded: [],
      };
    }

    this.sweep(request.now);
    const exceeded: AiBudgetExceeded[] = [];
    const activeReservation = this.activeRooms.get(request.identity.roomId);
    if (activeReservation) {
      exceeded.push({
        dimension: "room",
        metric: "concurrency",
        key: `ai-usage:room:${safeSegment(request.identity.roomId)}`,
        limit: 1,
        current: 1,
        requested: 1,
        retryAfterMs: 0,
      });
    }
    for (const dimension of request.dimensions) {
      exceeded.push(
        ...this.exceededForDimension(
          dimension,
          request.estimatedTokens,
          request.now,
        ),
      );
    }
    if (exceeded.length > 0) {
      return {
        allowed: false,
        idempotentReplay: false,
        exceeded,
        retryAfterMs: Math.max(
          0,
          ...exceeded.map((entry) => entry.retryAfterMs),
        ),
      };
    }

    const reservation: AiUsageReservation = {
      id: request.reservationId,
      identity: { ...request.identity },
      estimatedTokens: request.estimatedTokens,
      reservedAt: request.now,
      state: "reserved",
    };
    for (const dimension of request.dimensions) {
      const bucket = this.bucket(dimension.key);
      bucket.calls.push(request.now);
      bucket.reservedTokens.set(
        request.reservationId,
        request.estimatedTokens,
      );
    }
    this.activeRooms.set(request.identity.roomId, request.reservationId);
    this.reservations.set(request.reservationId, {
      public: reservation,
      dimensions: request.dimensions.map((dimension) => ({
        ...dimension,
        budget: { ...dimension.budget },
      })),
    });
    return {
      allowed: true,
      reservation: cloneReservation(reservation),
      idempotentReplay: false,
      exceeded: [],
    };
  }

  async settleAtomically(
    request: AiAtomicSettleRequest,
  ): Promise<AiSettleResult> {
    const stored = this.reservations.get(request.reservationId);
    if (!stored) {
      throw new AiReservationNotFoundError(request.reservationId);
    }
    if (stored.public.state === "settled") {
      if (!sameSettlement(stored.public, request)) {
        throw new AiReservationConflictError(
          `reservation ${request.reservationId} 已使用不同结果结算`,
        );
      }
      return {
        reservation: cloneReservation(stored.public),
        idempotentReplay: true,
        overageTokens: Math.max(
          0,
          request.promptTokens +
            request.completionTokens -
            stored.public.estimatedTokens,
        ),
        exceededAfterSettle: this.tokenOverages(stored.dimensions, request.now),
      };
    }

    const actualTokens = request.promptTokens + request.completionTokens;
    for (const dimension of stored.dimensions) {
      const bucket = this.bucket(dimension.key);
      bucket.reservedTokens.delete(request.reservationId);
      if (actualTokens > 0) {
        bucket.tokens.push({ at: request.now, tokens: actualTokens });
      }
    }
    if (
      this.activeRooms.get(stored.public.identity.roomId) ===
      request.reservationId
    ) {
      this.activeRooms.delete(stored.public.identity.roomId);
    }
    stored.public = {
      ...stored.public,
      state: "settled",
      settledAt: request.now,
      outcome: request.outcome,
      promptTokens: request.promptTokens,
      completionTokens: request.completionTokens,
    };
    this.sweep(request.now);
    return {
      reservation: cloneReservation(stored.public),
      idempotentReplay: false,
      overageTokens: Math.max(
        0,
        actualTokens - stored.public.estimatedTokens,
      ),
      exceededAfterSettle: this.tokenOverages(stored.dimensions, request.now),
    };
  }

  private exceededForDimension(
    dimension: ResolvedDimensionBudget,
    estimatedTokens: number,
    now: number,
  ): AiBudgetExceeded[] {
    const bucket = this.bucket(dimension.key);
    const reserved = [...bucket.reservedTokens.values()].reduce(
      (sum, tokens) => sum + tokens,
      0,
    );
    const hourlyCalls = this.callsSince(bucket, now - HOUR_MS);
    const dailyCalls = this.callsSince(bucket, now - DAY_MS);
    const hourlyTokens =
      this.tokensSince(bucket, now - HOUR_MS) + reserved;
    const dailyTokens = this.tokensSince(bucket, now - DAY_MS) + reserved;
    const metrics: Array<{
      metric: AiBudgetMetric;
      current: number;
      requested: number;
      limit: number;
      retryAfterMs: number;
    }> = [
      {
        metric: "hourly_calls",
        current: hourlyCalls,
        requested: 1,
        limit: dimension.budget.hourlyCalls,
        retryAfterMs: this.retryAfterCalls(
          bucket.calls,
          dimension.budget.hourlyCalls,
          HOUR_MS,
          now,
        ),
      },
      {
        metric: "daily_calls",
        current: dailyCalls,
        requested: 1,
        limit: dimension.budget.dailyCalls,
        retryAfterMs: this.retryAfterCalls(
          bucket.calls,
          dimension.budget.dailyCalls,
          DAY_MS,
          now,
        ),
      },
      {
        metric: "hourly_tokens",
        current: hourlyTokens,
        requested: estimatedTokens,
        limit: dimension.budget.hourlyTokens,
        retryAfterMs: HOUR_MS,
      },
      {
        metric: "daily_tokens",
        current: dailyTokens,
        requested: estimatedTokens,
        limit: dimension.budget.dailyTokens,
        retryAfterMs: DAY_MS,
      },
    ];
    return metrics
      .filter((entry) => entry.current + entry.requested > entry.limit)
      .map((entry) => ({
        dimension: dimension.dimension,
        key: dimension.key,
        ...entry,
      }));
  }

  private tokenOverages(
    dimensions: readonly ResolvedDimensionBudget[],
    now: number,
  ): AiBudgetExceeded[] {
    return dimensions.flatMap((dimension) => {
      const bucket = this.bucket(dimension.key);
      const reserved = [...bucket.reservedTokens.values()].reduce(
        (sum, tokens) => sum + tokens,
        0,
      );
      const hourly = this.tokensSince(bucket, now - HOUR_MS) + reserved;
      const daily = this.tokensSince(bucket, now - DAY_MS) + reserved;
      const exceeded: AiBudgetExceeded[] = [];
      if (hourly > dimension.budget.hourlyTokens) {
        exceeded.push({
          dimension: dimension.dimension,
          metric: "hourly_tokens",
          key: dimension.key,
          limit: dimension.budget.hourlyTokens,
          current: hourly,
          requested: 0,
          retryAfterMs: HOUR_MS,
        });
      }
      if (daily > dimension.budget.dailyTokens) {
        exceeded.push({
          dimension: dimension.dimension,
          metric: "daily_tokens",
          key: dimension.key,
          limit: dimension.budget.dailyTokens,
          current: daily,
          requested: 0,
          retryAfterMs: DAY_MS,
        });
      }
      return exceeded;
    });
  }

  private bucket(key: string): UsageBucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const created: UsageBucket = {
      calls: [],
      tokens: [],
      reservedTokens: new Map(),
    };
    this.buckets.set(key, created);
    return created;
  }

  private callsSince(bucket: UsageBucket, cutoff: number): number {
    return bucket.calls.reduce(
      (count, timestamp) => count + (timestamp > cutoff ? 1 : 0),
      0,
    );
  }

  private tokensSince(bucket: UsageBucket, cutoff: number): number {
    return bucket.tokens.reduce(
      (sum, event) => sum + (event.at > cutoff ? event.tokens : 0),
      0,
    );
  }

  private retryAfterCalls(
    timestamps: readonly number[],
    limit: number,
    windowMs: number,
    now: number,
  ): number {
    const active = timestamps
      .filter((timestamp) => timestamp > now - windowMs)
      .sort((left, right) => left - right);
    if (active.length < limit) return 0;
    return Math.max(1, (active[0] ?? now) + windowMs - now);
  }

  private sweep(now: number): void {
    const cutoff = now - DAY_MS;
    for (const [key, bucket] of this.buckets) {
      bucket.calls = bucket.calls.filter((timestamp) => timestamp > cutoff);
      bucket.tokens = bucket.tokens.filter((event) => event.at > cutoff);
      if (
        bucket.calls.length === 0 &&
        bucket.tokens.length === 0 &&
        bucket.reservedTokens.size === 0
      ) {
        this.buckets.delete(key);
      }
    }
  }
}

export interface AiUsageBudgetServiceOptions {
  repository?: AiUsageBudgetRepository;
  config?: AiUsageBudgetConfig;
  namespace?: string;
  now?: () => number;
}

export class AiUsageBudgetService {
  private readonly repository: AiUsageBudgetRepository;
  private readonly config: AiUsageBudgetConfig;
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(options: AiUsageBudgetServiceOptions = {}) {
    this.repository =
      options.repository ?? new MemoryAiUsageBudgetRepository();
    this.config = options.config ?? DEFAULT_AI_USAGE_BUDGET;
    this.namespace = options.namespace ?? "ai-usage";
    this.now = options.now ?? Date.now;
    validateConfig(this.config);
  }

  reserve(request: AiReserveRequest): Promise<AiReserveDecision> {
    this.validateReserve(request);
    const now = request.now ?? this.now();
    return this.repository.reserveAtomically({
      reservationId: request.reservationId,
      identity: { ...request.identity },
      estimatedTokens: request.estimatedTokens,
      now,
      dimensions: this.resolveDimensions(request.identity),
    });
  }

  settle(request: AiSettleRequest): Promise<AiSettleResult> {
    if (!request.reservationId.trim()) {
      throw new AiUsageBudgetConfigurationError(
        "reservationId 不能为空",
      );
    }
    validateNonnegativeInteger(request.promptTokens, "promptTokens");
    validateNonnegativeInteger(
      request.completionTokens,
      "completionTokens",
    );
    return this.repository.settleAtomically({
      reservationId: request.reservationId,
      outcome: request.outcome,
      promptTokens: request.promptTokens,
      completionTokens: request.completionTokens,
      now: request.now ?? this.now(),
    });
  }

  private validateReserve(request: AiReserveRequest): void {
    if (!request.reservationId.trim()) {
      throw new AiUsageBudgetConfigurationError(
        "reservationId 不能为空",
      );
    }
    validatePositiveInteger(request.estimatedTokens, "estimatedTokens");
    for (const [name, value] of Object.entries(request.identity)) {
      if (!value.trim()) {
        throw new AiUsageBudgetConfigurationError(`${name} 不能为空`);
      }
    }
  }

  private resolveDimensions(
    identity: AiUsageIdentity,
  ): ResolvedDimensionBudget[] {
    const values: Record<AiUsageDimension, string> = {
      room: identity.roomId,
      user: identity.userId,
      device: identity.deviceId,
      ip: identity.ip,
      global: "all",
    };
    return (
      ["room", "user", "device", "ip", "global"] as const
    ).map((dimension) => ({
      dimension,
      key: `${safeSegment(this.namespace)}:${dimension}:${safeSegment(values[dimension])}`,
      budget: this.config[dimension],
    }));
  }
}
