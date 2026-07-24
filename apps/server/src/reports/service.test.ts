import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryReportRepository } from "./repository.js";
import { ReportService } from "./service.js";

function evidence() {
  return {
    roomId: "room-1",
    reportedUserId: "user-2",
    opponentType: "human" as const,
    roomStartedAt: "2026-07-24T10:00:00.000Z",
    messages: Array.from({ length: 60 }, (_, index) => ({
      messageId: `m-${index}`,
      senderPseudonym: index % 2 ? "self" : "opponent",
      content: `message ${index}`,
      createdAt: "2026-07-24T10:00:00.000Z",
    })),
  };
}

describe("ReportService", () => {
  it("creates an immutable, capped evidence snapshot with audit fields", async () => {
    const repository = new MemoryReportRepository();
    const service = new ReportService(
      repository,
      () => new Date("2026-07-24T10:01:00.000Z"),
    );
    const report = await service.create({
      reporterId: "user-1",
      reasonCode: "THREAT",
      evidence: evidence(),
      audit: { actorId: "user-1", traceId: "trace-1" },
    });
    assert.equal(report.severity, 4);
    assert.equal(report.evidence.messages.length, 50);
    assert.equal(report.audit.traceId, "trace-1");

    report.status = "DISMISSED";
    assert.equal((await repository.findById(report.id))?.status, "OPEN");
  });

  it("enforces terminal review transitions", async () => {
    const repository = new MemoryReportRepository();
    const service = new ReportService(repository);
    const report = await service.create({
      reporterId: "user-1",
      reasonCode: "SCAM",
      evidence: evidence(),
      audit: { actorId: "user-1" },
    });
    await service.transition(
      report.id,
      "ACTIONED",
      { actorId: "admin-1" },
      "confirmed",
    );
    await assert.rejects(
      () =>
        service.transition(report.id, "DISMISSED", {
          actorId: "admin-1",
        }),
      /Cannot transition/,
    );
  });
});
