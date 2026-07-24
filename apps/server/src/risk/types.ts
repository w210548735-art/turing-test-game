import type { AuditStamp } from "./audit.js";

export type BanScope = "USER" | "SESSION" | "IP" | "DEVICE";
export type BanReasonCode =
  | "MINOR_SAFETY"
  | "CREDIBLE_THREAT"
  | "SCAM"
  | "HATE"
  | "SEXUAL"
  | "HARASSMENT"
  | "BAN_EVASION"
  | "RATE_ABUSE"
  | "MANUAL";

export interface BanRecord {
  id: string;
  scope: BanScope;
  subjectHash: string;
  reasonCode: BanReasonCode;
  note?: string;
  active: boolean;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  audit: AuditStamp;
  revokeAudit?: AuditStamp;
}

export interface RiskSignal {
  id: string;
  subjectHash: string;
  scope: BanScope;
  type:
    | "MODERATION_BLOCK"
    | "MODERATION_TERMINATE"
    | "REPORT_CONFIRMED"
    | "RATE_LIMIT"
    | "BAN_EVASION";
  weight: number;
  occurredAt: string;
  audit: AuditStamp;
}

export interface RiskAssessment {
  disposition: "ALLOW" | "REVIEW" | "BLOCK";
  score: number;
  activeBan?: BanRecord;
  reasons: string[];
}
