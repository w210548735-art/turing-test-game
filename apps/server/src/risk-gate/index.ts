export {
  ActionBoundCaptchaService,
  type CaptchaProvider,
  type IssuedCaptchaTicket,
} from "./captcha.js";
export { RuleRiskGate, actionForScore } from "./risk-gate.js";
export {
  DecayingMemoryRiskSignalRepository,
  type RiskSignalRepository,
} from "./signal-repository.js";
export { TestCaptchaProvider } from "./testing.js";
export type {
  RiskAction,
  RiskAssessment,
  RiskGateConfig,
  RiskSignal,
  RiskThresholds,
} from "./types.js";
