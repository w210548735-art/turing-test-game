import type { AuditStamp } from "../risk/audit.js";

export type ReportReasonCode =
  | "HARASSMENT"
  | "THREAT"
  | "HATE"
  | "SEXUAL"
  | "MINOR_SAFETY"
  | "SELF_HARM"
  | "SCAM"
  | "PERSONAL_DATA"
  | "OTHER";

export type ReportStatus =
  | "OPEN"
  | "UNDER_REVIEW"
  | "ACTIONED"
  | "DISMISSED";

export interface ReportEvidenceMessage {
  messageId: string;
  senderPseudonym: string;
  content: string;
  createdAt: string;
}

export interface ReportEvidence {
  roomId: string;
  reportedUserId: string;
  opponentType: "human" | "ai";
  messages: ReportEvidenceMessage[];
  roomStartedAt: string;
  roomEndedAt?: string;
}

export interface ReportAction {
  action: "ASSIGNED" | "NOTE_ADDED" | "USER_BANNED" | "DISMISSED";
  note?: string;
  audit: AuditStamp;
}

export interface SafetyReport {
  id: string;
  reporterId: string;
  reportedUserId: string;
  reasonCode: ReportReasonCode;
  description: string;
  status: ReportStatus;
  severity: 1 | 2 | 3 | 4;
  evidence: ReportEvidence;
  createdAt: string;
  updatedAt: string;
  audit: AuditStamp;
  actions: ReportAction[];
}
