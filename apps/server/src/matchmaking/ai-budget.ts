import type { RedisRuntime } from "../redis/client.js";
import {
  createMemoryRedisRuntime,
  getRuntimeMemoryState,
} from "../redis/client.js";
import { RedisKeys } from "../redis/keys.js";

export const AI_RATIO_TARGET = 0.25;
export const AI_RATIO_HARD_LIMIT = 0.3;

export interface AiBudgetStats {
  recent10Games: number;
  recent10AiGames: number;
  recent100Games: number;
  recent100AiGames: number;
  recent100Ratio: number;
  targetRatio: number;
  hardLimitRatio: number;
}

export interface AiBudgetDecision {
  allowed: boolean;
  reason: "within_budget" | "recent_10_limit" | "recent_100_limit";
  stats: AiBudgetStats;
}

export interface AiBudgetControllerOptions {
  runtime?: RedisRuntime;
  keys?: RedisKeys;
}

const RESERVE_AI_SCRIPT = `
local entries = redis.call("LRANGE", KEYS[1], -99, -1)

local function candidate_window(max_games)
  local prior_limit = max_games - 1
  local start_at = math.max(1, #entries - prior_limit + 1)
  local games = 1
  local ai_games = 1
  for index = start_at, #entries do
    games = games + 1
    if entries[index] == "ai" then
      ai_games = ai_games + 1
    end
  end
  return games, ai_games
end

local games10, ai10 = candidate_window(10)
local games100, ai100 = candidate_window(100)
local allowed10 = ai10 <= 3 and ai10 <= math.floor(games10 * 0.30)
local allowed100 = ai100 <= 30 and ai100 <= math.floor(games100 * 0.30)

if not allowed10 or not allowed100 then
  return {0, games10, ai10, games100, ai100}
end

redis.call("RPUSH", KEYS[1], "ai")
redis.call("LTRIM", KEYS[1], -100, -1)
return {1, games10, ai10, games100, ai100}
`;

const RECORD_HUMAN_SCRIPT = `
redis.call("RPUSH", KEYS[1], "human")
redis.call("LTRIM", KEYS[1], -100, -1)
return redis.call("LLEN", KEYS[1])
`;

/**
 * AI 配额以“已创建的对局”记录，而不是以在线玩家数推测。
 * reserveAiGame 将检查和写入放在同一原子操作内，避免多实例同时穿透上限。
 */
export class AiBudgetController {
  private readonly runtime: RedisRuntime;
  private readonly keys: RedisKeys;
  private readonly memoryHistory: Array<"human" | "ai">;

  constructor(options: AiBudgetControllerOptions = {}) {
    this.runtime = options.runtime ?? createMemoryRedisRuntime();
    this.keys = options.keys ?? new RedisKeys();
    this.memoryHistory = this.runtime.memory
      ? getRuntimeMemoryState(
          this.runtime,
          "ai-budget-history",
          () => [] as Array<"human" | "ai">,
        )
      : [];
  }

  async recordHumanGame(): Promise<AiBudgetStats> {
    if (this.runtime.client) {
      await this.runtime.client.eval(
        RECORD_HUMAN_SCRIPT,
        [this.keys.aiHistory()],
        [],
      );
    } else {
      this.pushMemory("human");
    }
    return this.getStats();
  }

  async reserveAiGame(): Promise<AiBudgetDecision> {
    if (this.runtime.client) {
      const result = await this.runtime.client.eval(
        RESERVE_AI_SCRIPT,
        [this.keys.aiHistory()],
        [],
      );
      if (!Array.isArray(result) || result.length < 5) {
        throw new Error("Redis 返回了无效的 AI 配额结果。");
      }
      const allowed = Number(result[0]) === 1;
      const stats = await this.getStats();
      return {
        allowed,
        reason: allowed
          ? "within_budget"
          : this.decisionReason(
              Number(result[1]),
              Number(result[2]),
              Number(result[3]),
              Number(result[4]),
            ),
        stats,
      };
    }

    const candidate = [...this.memoryHistory, "ai" as const];
    const recent10 = candidate.slice(-10);
    const recent100 = candidate.slice(-100);
    const recent10Ai = this.countAi(recent10);
    const recent100Ai = this.countAi(recent100);
    const allowed10 =
      recent10Ai <= 3 &&
      recent10Ai <= Math.floor(recent10.length * AI_RATIO_HARD_LIMIT);
    const allowed100 =
      recent100Ai <= 30 &&
      recent100Ai <= Math.floor(recent100.length * AI_RATIO_HARD_LIMIT);
    if (allowed10 && allowed100) {
      this.pushMemory("ai");
    }
    return {
      allowed: allowed10 && allowed100,
      reason:
        allowed10 && allowed100
          ? "within_budget"
          : this.decisionReason(
              recent10.length,
              recent10Ai,
              recent100.length,
              recent100Ai,
            ),
      stats: this.statsFromHistory(this.memoryHistory),
    };
  }

  async getStats(): Promise<AiBudgetStats> {
    if (!this.runtime.client) {
      return this.statsFromHistory(this.memoryHistory);
    }
    const raw = await this.runtime.client.call(
      "LRANGE",
      this.keys.aiHistory(),
      -99,
      -1,
    );
    const history = Array.isArray(raw)
      ? raw.filter(
          (entry): entry is "human" | "ai" =>
            entry === "human" || entry === "ai",
        )
      : [];
    return this.statsFromHistory(history);
  }

  private pushMemory(kind: "human" | "ai"): void {
    this.memoryHistory.push(kind);
    if (this.memoryHistory.length > 100) {
      this.memoryHistory.splice(0, this.memoryHistory.length - 100);
    }
  }

  private countAi(history: ReadonlyArray<"human" | "ai">): number {
    return history.reduce(
      (total, kind) => total + (kind === "ai" ? 1 : 0),
      0,
    );
  }

  private statsFromHistory(
    history: ReadonlyArray<"human" | "ai">,
  ): AiBudgetStats {
    const recent10 = history.slice(-10);
    const recent100 = history.slice(-100);
    const recent100AiGames = this.countAi(recent100);
    return {
      recent10Games: recent10.length,
      recent10AiGames: this.countAi(recent10),
      recent100Games: recent100.length,
      recent100AiGames,
      recent100Ratio:
        recent100.length === 0 ? 0 : recent100AiGames / recent100.length,
      targetRatio: AI_RATIO_TARGET,
      hardLimitRatio: AI_RATIO_HARD_LIMIT,
    };
  }

  private decisionReason(
    games10: number,
    ai10: number,
    games100: number,
    ai100: number,
  ): AiBudgetDecision["reason"] {
    if (
      ai10 > 3 ||
      ai10 > Math.floor(games10 * AI_RATIO_HARD_LIMIT)
    ) {
      return "recent_10_limit";
    }
    if (
      ai100 > 30 ||
      ai100 > Math.floor(games100 * AI_RATIO_HARD_LIMIT)
    ) {
      return "recent_100_limit";
    }
    return "within_budget";
  }
}
