import { randomUUID } from "node:crypto";
import type { RiskSignalRepository } from "./signal-repository.js";
import type {
  RiskAction,
  RiskAssessment,
  RiskGateConfig,
  RiskSignal,
  RiskThresholds,
} from "./types.js";

export class RuleRiskGate {
  readonly #maximumScore: number;

  constructor(
    private readonly repository: RiskSignalRepository,
    private readonly config: RiskGateConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateThresholds(config.thresholds);
    if (!Number.isFinite(config.halfLifeMs) || config.halfLifeMs <= 0) {
      throw new TypeError("风险分半衰期必须大于 0");
    }
    if (!Number.isFinite(config.retentionMs) || config.retentionMs <= 0) {
      throw new TypeError("风险信号保留时间必须大于 0");
    }
    this.#maximumScore = config.maximumScore ?? 100;
    if (
      !Number.isFinite(this.#maximumScore) ||
      this.#maximumScore < config.thresholds.reject
    ) {
      throw new TypeError("风险分上限不能低于拒绝阈值");
    }
  }

  record(input: {
    readonly subjectKey: string;
    readonly type: string;
    readonly weight: number;
    readonly occurredAt?: Date;
  }): RiskSignal {
    const signal: RiskSignal = {
      id: randomUUID(),
      subjectKey: input.subjectKey,
      type: input.type,
      weight: input.weight,
      occurredAt: new Date(input.occurredAt ?? this.now()),
    };
    this.repository.add(signal);
    return signal;
  }

  assess(subjectKey: string, at = this.now()): RiskAssessment {
    if (!subjectKey) throw new TypeError("风险主体不能为空");
    if (Number.isNaN(at.getTime())) throw new TypeError("评估时间不合法");

    const contributions = this.repository
      .list(subjectKey, at)
      // 防止未来时间戳放大权重；未来信号按刚发生处理。
      .map((signal) => ({
        signal,
        value:
          signal.weight *
          2 **
            (-Math.max(0, at.getTime() - signal.occurredAt.getTime()) /
              this.config.halfLifeMs),
      }));
    const score = Math.min(
      this.#maximumScore,
      contributions.reduce((total, item) => total + item.value, 0),
    );

    return {
      subjectKey,
      score,
      action: actionForScore(score, this.config.thresholds),
      reasons: [
        ...new Set(
          contributions
            .filter((item) => item.value >= 0.01)
            .sort((left, right) => right.value - left.value)
            .map((item) => item.signal.type),
        ),
      ],
      assessedAt: new Date(at),
    };
  }
}

export function actionForScore(
  score: number,
  thresholds: RiskThresholds,
): RiskAction {
  if (score >= thresholds.reject) return "REJECT";
  if (score >= thresholds.limit) return "LIMIT";
  if (score >= thresholds.captcha) return "CAPTCHA";
  if (score >= thresholds.throttle) return "THROTTLE";
  return "ALLOW";
}

function validateThresholds(thresholds: RiskThresholds): void {
  const values = [
    thresholds.throttle,
    thresholds.captcha,
    thresholds.limit,
    thresholds.reject,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value <= 0) ||
    values.some((value, index) => index > 0 && value <= values[index - 1]!)
  ) {
    throw new TypeError("风险阈值必须为严格递增的正数");
  }
}
