import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BanService, MemoryBanRepository } from "./service.js";

describe("BanService", () => {
  it("stores only hashed identifiers and blocks active bans", async () => {
    const repository = new MemoryBanRepository();
    const service = new BanService(
      repository,
      "alpha-test-pepper-very-secret",
    );
    const ban = await service.issue({
      scope: "IP",
      identifier: "203.0.113.42",
      reasonCode: "BAN_EVASION",
      audit: { actorId: "admin-1" },
    });
    assert.equal(ban.subjectHash.includes("203.0.113.42"), false);
    assert.equal(
      (await service.assess("IP", "203.0.113.42")).disposition,
      "BLOCK",
    );
  });

  it("escalates recent weighted signals and supports audited revocation", async () => {
    const repository = new MemoryBanRepository();
    const service = new BanService(
      repository,
      "alpha-test-pepper-very-secret",
    );
    await service.recordSignal({
      scope: "USER",
      identifier: "user-1",
      type: "MODERATION_BLOCK",
      weight: 40,
      audit: { actorId: "system" },
    });
    assert.equal(
      (await service.assess("USER", "user-1")).disposition,
      "REVIEW",
    );
    const ban = await service.issue({
      scope: "USER",
      identifier: "user-1",
      reasonCode: "HARASSMENT",
      audit: { actorId: "admin-1" },
    });
    const revoked = await service.revoke(ban.id, { actorId: "admin-2" });
    assert.equal(revoked.active, false);
    assert.equal(revoked.revokeAudit?.actorId, "admin-2");
  });
});
