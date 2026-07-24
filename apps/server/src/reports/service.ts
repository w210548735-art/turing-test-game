import { randomUUID } from "node:crypto";
import { createAuditStamp, type AuditContext } from "../risk/audit.js";
import type { ReportRepository } from "./repository.js";
import type {
  ReportAction,
  ReportEvidence,
  ReportReasonCode,
  ReportStatus,
  SafetyReport,
} from "./types.js";

const VALID_REASONS = new Set<ReportReasonCode>([
  "HARASSMENT",
  "THREAT",
  "HATE",
  "SEXUAL",
  "MINOR_SAFETY",
  "SELF_HARM",
  "SCAM",
  "PERSONAL_DATA",
  "OTHER",
]);

const SEVERITY: Record<ReportReasonCode, 1 | 2 | 3 | 4> = {
  HARASSMENT: 2,
  THREAT: 4,
  HATE: 3,
  SEXUAL: 3,
  MINOR_SAFETY: 4,
  SELF_HARM: 4,
  SCAM: 3,
  PERSONAL_DATA: 3,
  OTHER: 1,
};

export class ReportServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReportServiceError";
  }
}

export interface CreateReportInput {
  reporterId: string;
  reasonCode: ReportReasonCode;
  description?: string;
  evidence: ReportEvidence;
  audit: AuditContext;
}

export class ReportService {
  constructor(
    private readonly repository: ReportRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateReportInput): Promise<SafetyReport> {
    if (!VALID_REASONS.has(input.reasonCode)) {
      throw new ReportServiceError("INVALID_REASON", "Invalid report reason");
    }
    if (
      !input.evidence.roomId ||
      !input.evidence.reportedUserId ||
      input.evidence.reportedUserId === input.reporterId
    ) {
      throw new ReportServiceError(
        "INVALID_TARGET",
        "Report target is invalid",
      );
    }
    const recent = await this.repository.countRecentByReporter(
      input.reporterId,
      new Date(this.now().getTime() - 60 * 60_000),
    );
    if (recent >= 5) {
      throw new ReportServiceError(
        "REPORT_RATE_LIMITED",
        "Too many reports in the current hour",
      );
    }
    const description = (input.description ?? "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "")
      .trim();
    if ([...description].length > 500) {
      throw new ReportServiceError(
        "DESCRIPTION_TOO_LONG",
        "Report description exceeds 500 characters",
      );
    }

    const createdAt = this.now().toISOString();
    const report: SafetyReport = {
      id: randomUUID(),
      reporterId: input.reporterId,
      reportedUserId: input.evidence.reportedUserId,
      reasonCode: input.reasonCode,
      description,
      severity: SEVERITY[input.reasonCode],
      status: "OPEN",
      evidence: {
        ...structuredClone(input.evidence),
        messages: input.evidence.messages.slice(-50),
      },
      createdAt,
      updatedAt: createdAt,
      audit: createAuditStamp(input.audit, new Date(createdAt)),
      actions: [],
    };
    await this.repository.save(report);
    return report;
  }

  async transition(
    reportId: string,
    status: ReportStatus,
    adminAudit: AuditContext,
    note?: string,
  ): Promise<SafetyReport> {
    const report = await this.repository.findById(reportId);
    if (!report) {
      throw new ReportServiceError("REPORT_NOT_FOUND", "Report not found");
    }
    const allowed: Record<ReportStatus, ReportStatus[]> = {
      OPEN: ["UNDER_REVIEW", "ACTIONED", "DISMISSED"],
      UNDER_REVIEW: ["ACTIONED", "DISMISSED"],
      ACTIONED: [],
      DISMISSED: [],
    };
    if (!allowed[report.status].includes(status)) {
      throw new ReportServiceError(
        "INVALID_TRANSITION",
        `Cannot transition ${report.status} to ${status}`,
      );
    }
    const actionType: ReportAction["action"] =
      status === "UNDER_REVIEW"
        ? "ASSIGNED"
        : status === "ACTIONED"
          ? "USER_BANNED"
          : "DISMISSED";
    report.status = status;
    report.updatedAt = this.now().toISOString();
    report.actions.push({
      action: actionType,
      ...(note ? { note: [...note.normalize("NFKC")].slice(0, 500).join("") } : {}),
      audit: createAuditStamp(adminAudit, this.now()),
    });
    await this.repository.save(report);
    return report;
  }
}
