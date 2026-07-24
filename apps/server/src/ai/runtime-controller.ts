import { AppError } from "../errors.js";

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiRuntimeSnapshot {
  active: number;
  maxConcurrency: number;
  hourlyRequests: number;
  hourlyLimit: number;
  dailyTokens: number;
  dailyTokenBudget: number;
  circuitOpenUntil: number | null;
}

interface WindowCounter {
  startedAt: number;
  value: number;
}

export class AiRuntimeController {
  private active = 0;
  private hourly: WindowCounter = { startedAt: Date.now(), value: 0 };
  private daily: WindowCounter = { startedAt: Date.now(), value: 0 };
  private failures: number[] = [];
  private circuitOpenUntil = 0;

  constructor(
    private readonly maxConcurrency = Number.parseInt(
      process.env.AI_MAX_CONCURRENCY ?? "20",
      10,
    ),
    private readonly hourlyLimit = Number.parseInt(
      process.env.AI_HOURLY_REQUEST_LIMIT ?? "1000",
      10,
    ),
    private readonly dailyTokenBudget = Number.parseInt(
      process.env.AI_DAILY_TOKEN_BUDGET ?? "1000000",
      10,
    ),
    private readonly now: () => number = Date.now,
  ) {}

  async execute<T>(
    operation: () => Promise<{ value: T; usage: AiUsage }>,
  ): Promise<T> {
    this.refreshWindows();
    const now = this.now();
    if (this.circuitOpenUntil > now) {
      throw new AppError(
        "AI_UNAVAILABLE",
        "AI 服务暂时繁忙，请稍后重试。",
        503,
      );
    }
    if (
      this.active >= this.maxConcurrency ||
      this.hourly.value >= this.hourlyLimit ||
      this.daily.value >= this.dailyTokenBudget
    ) {
      throw new AppError(
        "AI_UNAVAILABLE",
        "AI 当前达到使用上限，请稍后重试。",
        503,
      );
    }

    this.active += 1;
    this.hourly.value += 1;
    try {
      const result = await operation();
      this.daily.value +=
        result.usage.promptTokens + result.usage.completionTokens;
      this.failures = [];
      return result.value;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      this.active -= 1;
    }
  }

  snapshot(): AiRuntimeSnapshot {
    this.refreshWindows();
    return {
      active: this.active,
      maxConcurrency: this.maxConcurrency,
      hourlyRequests: this.hourly.value,
      hourlyLimit: this.hourlyLimit,
      dailyTokens: this.daily.value,
      dailyTokenBudget: this.dailyTokenBudget,
      circuitOpenUntil:
        this.circuitOpenUntil > this.now() ? this.circuitOpenUntil : null,
    };
  }

  private recordFailure(): void {
    const now = this.now();
    this.failures = [...this.failures.filter((time) => now - time < 60_000), now];
    if (this.failures.length >= 5) {
      this.circuitOpenUntil = now + 30_000;
      this.failures = [];
    }
  }

  private refreshWindows(): void {
    const now = this.now();
    if (now - this.hourly.startedAt >= 60 * 60_000) {
      this.hourly = { startedAt: now, value: 0 };
    }
    if (now - this.daily.startedAt >= 24 * 60 * 60_000) {
      this.daily = { startedAt: now, value: 0 };
    }
  }
}

export const aiRuntimeController = new AiRuntimeController();
