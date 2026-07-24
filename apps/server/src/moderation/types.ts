import type { AuditContext, AuditStamp } from "../risk/audit.js";

export type ModerationAction = "ALLOW" | "REDACT" | "BLOCK" | "TERMINATE";

export type ModerationCategory =
  | "CONTACT"
  | "PERSONAL_DATA"
  | "URL"
  | "SCAM"
  | "HATE"
  | "SEXUAL"
  | "MINOR_SEXUAL"
  | "SELF_HARM"
  | "VIOLENT_THREAT"
  | "SYSTEM_IMPERSONATION";

export type ModerationSurface =
  | "CHAT"
  | "PROFILE"
  | "AI_OUTPUT"
  | "REPORT_REASON";

export interface ModerationInput {
  text: unknown;
  surface: ModerationSurface;
  audit: AuditContext;
}

export interface ModerationMatch {
  ruleId: string;
  category: ModerationCategory;
  action: Exclude<ModerationAction, "ALLOW">;
}

export interface ModerationDecision {
  action: ModerationAction;
  text: string;
  originalLength: number;
  categories: ModerationCategory[];
  matches: ModerationMatch[];
  userMessage?: string;
  safetyResourceCode?: "IMMEDIATE_DANGER" | "SELF_HARM_SUPPORT";
  audit: AuditStamp & {
    policyVersion: string;
    surface: ModerationSurface;
    contentSha256: string;
  };
}
