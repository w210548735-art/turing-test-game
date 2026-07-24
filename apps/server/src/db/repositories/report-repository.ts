import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../client.js";
import {
  moderationEvents,
  reports,
  type ModerationEventRow,
  type NewModerationEventRow,
  type NewReportRow,
  type ReportRow,
} from "../schema.js";

function requiredRow<T>(row: T | undefined, operation: string): T {
  if (!row) {
    throw new Error(`数据库操作未返回记录：${operation}`);
  }
  return row;
}

export class ReportRepository {
  constructor(private readonly db: AppDatabase) {}

  async create(input: NewReportRow): Promise<ReportRow> {
    const [row] = await this.db.insert(reports).values(input).returning();
    return requiredRow(row, "createReport");
  }

  async listPending(limit = 50): Promise<ReportRow[]> {
    return this.list("pending", limit);
  }

  async list(
    status?: "pending" | "reviewing" | "resolved" | "dismissed",
    limit = 50,
  ): Promise<ReportRow[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const query = this.db
      .select()
      .from(reports)
      .orderBy(asc(reports.createdAt))
      .limit(safeLimit);
    return status
      ? query.where(eq(reports.status, status))
      : query;
  }

  async setStatus(
    reportId: string,
    status: "reviewing" | "resolved" | "dismissed",
    reviewerNote?: string,
  ): Promise<ReportRow | null> {
    const [row] = await this.db
      .update(reports)
      .set({
        status,
        reviewerNote,
        reviewedAt: status === "reviewing" ? null : new Date(),
      })
      .where(eq(reports.id, reportId))
      .returning();
    return row ?? null;
  }

  async recordModerationEvent(
    input: NewModerationEventRow,
  ): Promise<ModerationEventRow> {
    const [row] = await this.db
      .insert(moderationEvents)
      .values(input)
      .returning();
    return requiredRow(row, "recordModerationEvent");
  }
}
