import { createHash, randomUUID } from "node:crypto";
import { createAuditStamp, type AuditContext } from "./audit.js";
import type {
  BanReasonCode,
  BanRecord,
  BanScope,
  RiskAssessment,
  RiskSignal,
} from "./types.js";

export interface BanRepository {
  saveBan(record: BanRecord): Promise<void>;
  findActiveBan(scope: BanScope, subjectHash: string): Promise<BanRecord | undefined>;
  findBanById(id: string): Promise<BanRecord | undefined>;
  saveSignal(signal: RiskSignal): Promise<void>;
  listSignals(subjectHash: string, since: Date): Promise<RiskSignal[]>;
}

export class MemoryBanRepository implements BanRepository {
  private readonly bans = new Map<string, BanRecord>();
  private readonly signals: RiskSignal[] = [];

  async saveBan(record: BanRecord): Promise<void> {
    this.bans.set(record.id, structuredClone(record));
  }

  async findActiveBan(
    scope: BanScope,
    subjectHash: string,
  ): Promise<BanRecord | undefined> {
    const now = Date.now();
    const record = [...this.bans.values()].find(
      (ban) =>
        ban.scope === scope &&
        ban.subjectHash === subjectHash &&
        ban.active &&
        (!ban.expiresAt || new Date(ban.expiresAt).getTime() > now),
    );
    return record ? structuredClone(record) : undefined;
  }

  async findBanById(id: string): Promise<BanRecord | undefined> {
    const record = this.bans.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async saveSignal(signal: RiskSignal): Promise<void> {
    this.signals.push(structuredClone(signal));
  }

  async listSignals(subjectHash: string, since: Date): Promise<RiskSignal[]> {
    return this.signals
      .filter(
        (signal) =>
          signal.subjectHash === subjectHash &&
          new Date(signal.occurredAt).getTime() >= since.getTime(),
      )
      .map((signal) => structuredClone(signal));
  }
}

export class BanService {
  constructor(
    private readonly repository: BanRepository,
    private readonly identifierPepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (identifierPepper.length < 16) {
      throw new Error("Ban identifier pepper must contain at least 16 characters");
    }
  }

  hashSubject(scope: BanScope, identifier: string): string {
    return createHash("sha256")
      .update(`${this.identifierPepper}:${scope}:${identifier.normalize("NFKC")}`)
      .digest("hex");
  }

  async issue(input: {
    scope: BanScope;
    identifier: string;
    reasonCode: BanReasonCode;
    durationMs?: number;
    note?: string;
    audit: AuditContext;
  }): Promise<BanRecord> {
    const now = this.now();
    const subjectHash = this.hashSubject(input.scope, input.identifier);
    const existing = await this.repository.findActiveBan(
      input.scope,
      subjectHash,
    );
    if (existing) return existing;
    const record: BanRecord = {
      id: randomUUID(),
      scope: input.scope,
      subjectHash,
      reasonCode: input.reasonCode,
      ...(input.note
        ? { note: [...input.note.normalize("NFKC")].slice(0, 500).join("") }
        : {}),
      active: true,
      createdAt: now.toISOString(),
      ...(input.durationMs
        ? { expiresAt: new Date(now.getTime() + input.durationMs).toISOString() }
        : {}),
      audit: createAuditStamp(input.audit, now),
    };
    await this.repository.saveBan(record);
    return record;
  }

  async revoke(
    banId: string,
    audit: AuditContext,
  ): Promise<BanRecord> {
    const record = await this.repository.findBanById(banId);
    if (!record) throw new Error("Ban not found");
    if (!record.active) return record;
    record.active = false;
    record.revokedAt = this.now().toISOString();
    record.revokeAudit = createAuditStamp(audit, this.now());
    await this.repository.saveBan(record);
    return record;
  }

  async recordSignal(input: {
    scope: BanScope;
    identifier: string;
    type: RiskSignal["type"];
    weight: number;
    audit: AuditContext;
  }): Promise<RiskSignal> {
    const signal: RiskSignal = {
      id: randomUUID(),
      scope: input.scope,
      subjectHash: this.hashSubject(input.scope, input.identifier),
      type: input.type,
      weight: Math.min(Math.max(Math.round(input.weight), 1), 100),
      occurredAt: this.now().toISOString(),
      audit: createAuditStamp(input.audit, this.now()),
    };
    await this.repository.saveSignal(signal);
    return signal;
  }

  async assess(scope: BanScope, identifier: string): Promise<RiskAssessment> {
    const subjectHash = this.hashSubject(scope, identifier);
    const activeBan = await this.repository.findActiveBan(scope, subjectHash);
    if (activeBan) {
      return {
        disposition: "BLOCK",
        score: 100,
        activeBan,
        reasons: [`ACTIVE_BAN:${activeBan.reasonCode}`],
      };
    }
    const signals = await this.repository.listSignals(
      subjectHash,
      new Date(this.now().getTime() - 24 * 60 * 60_000),
    );
    const score = Math.min(
      100,
      signals.reduce((total, signal) => total + signal.weight, 0),
    );
    return {
      disposition: score >= 70 ? "BLOCK" : score >= 35 ? "REVIEW" : "ALLOW",
      score,
      reasons: [...new Set(signals.map((signal) => signal.type))],
    };
  }
}
