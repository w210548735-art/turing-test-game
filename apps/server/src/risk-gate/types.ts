export type RiskAction =
  | "ALLOW"
  | "THROTTLE"
  | "CAPTCHA"
  | "LIMIT"
  | "REJECT";

export interface RiskSignal {
  readonly id: string;
  readonly subjectKey: string;
  readonly type: string;
  readonly weight: number;
  readonly occurredAt: Date;
}

export interface RiskAssessment {
  readonly subjectKey: string;
  readonly score: number;
  readonly action: RiskAction;
  readonly reasons: readonly string[];
  readonly assessedAt: Date;
}

export interface RiskThresholds {
  readonly throttle: number;
  readonly captcha: number;
  readonly limit: number;
  readonly reject: number;
}

export interface RiskGateConfig {
  readonly thresholds: RiskThresholds;
  readonly halfLifeMs: number;
  readonly retentionMs: number;
  readonly maximumScore?: number;
}
