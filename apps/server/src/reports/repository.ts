import type { ReportStatus, SafetyReport } from "./types.js";

export interface ReportQuery {
  status?: ReportStatus;
  reportedUserId?: string;
  limit?: number;
}

export interface ReportRepository {
  save(report: SafetyReport): Promise<void>;
  findById(id: string): Promise<SafetyReport | undefined>;
  countRecentByReporter(
    reporterId: string,
    since: Date,
  ): Promise<number>;
  list(query?: ReportQuery): Promise<SafetyReport[]>;
}

export class MemoryReportRepository implements ReportRepository {
  private readonly reports = new Map<string, SafetyReport>();

  async save(report: SafetyReport): Promise<void> {
    this.reports.set(report.id, structuredClone(report));
  }

  async findById(id: string): Promise<SafetyReport | undefined> {
    const report = this.reports.get(id);
    return report ? structuredClone(report) : undefined;
  }

  async countRecentByReporter(
    reporterId: string,
    since: Date,
  ): Promise<number> {
    return [...this.reports.values()].filter(
      (report) =>
        report.reporterId === reporterId &&
        new Date(report.createdAt).getTime() >= since.getTime(),
    ).length;
  }

  async list(query: ReportQuery = {}): Promise<SafetyReport[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    return [...this.reports.values()]
      .filter(
        (report) =>
          (!query.status || report.status === query.status) &&
          (!query.reportedUserId ||
            report.reportedUserId === query.reportedUserId),
      )
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      )
      .slice(0, limit)
      .map((report) => structuredClone(report));
  }
}
