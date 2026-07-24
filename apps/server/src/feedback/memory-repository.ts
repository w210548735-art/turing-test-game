import { randomUUID } from "node:crypto";
import type {
  ClaimFeedbackDigestInput,
  FeedbackDigestClaim,
  FeedbackRecord,
  FeedbackRepositoryPort,
  NewFeedback,
} from "./types.js";

interface MemoryDigestRun extends FeedbackDigestClaim {
  status: "sending" | "sent" | "failed";
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date;
}

export class MemoryFeedbackRepository implements FeedbackRepositoryPort {
  readonly records: FeedbackRecord[] = [];
  readonly digests: MemoryDigestRun[] = [];
  now: () => Date = () => new Date();

  async create(input: NewFeedback): Promise<FeedbackRecord> {
    const record: FeedbackRecord = {
      id: randomUUID(),
      ...input,
      deliveryStatus: "pending",
      deliveredAt: null,
      digestRunId: null,
      createdAt: this.now(),
    };
    this.records.push(record);
    return record;
  }

  async claimDigest(
    input: ClaimFeedbackDigestInput,
  ): Promise<FeedbackDigestClaim | null> {
    for (const digest of this.digests) {
      if (
        digest.status === "sending" &&
        digest.leaseExpiresAt &&
        digest.leaseExpiresAt <= input.now
      ) {
        digest.status = "failed";
        digest.leaseOwner = null;
        digest.leaseExpiresAt = null;
        digest.nextAttemptAt = input.now;
      }
    }
    const retry = this.digests.find(
      (digest) =>
        digest.status === "failed" &&
        digest.nextAttemptAt <= input.now,
    );
    if (retry) {
      retry.status = "sending";
      retry.leaseOwner = input.leaseOwner;
      retry.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      retry.attemptCount += 1;
      return this.publicClaim(retry);
    }
    if (this.digests.some((digest) => digest.status !== "sent")) {
      return null;
    }
    const eligible = this.records.filter(
      (record) =>
        record.digestRunId === null &&
        record.deliveryStatus !== "sent" &&
        record.createdAt <= input.cutoffAt,
    );
    if (eligible.length === 0) return null;
    const id = randomUUID();
    const digest: MemoryDigestRun = {
      id,
      cutoffAt: input.cutoffAt,
      messageId: `<feedback-digest-${id}@turing-game.local>`,
      attemptCount: 1,
      feedback: eligible,
      status: "sending",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      nextAttemptAt: input.now,
    };
    for (const record of eligible) record.digestRunId = id;
    this.digests.push(digest);
    return this.publicClaim(digest);
  }

  async markDigestSent(
    digestId: string,
    leaseOwner: string,
    sentAt: Date,
  ): Promise<void> {
    const digest = this.requiredDigest(digestId, leaseOwner);
    digest.status = "sent";
    digest.leaseOwner = null;
    digest.leaseExpiresAt = null;
    for (const record of digest.feedback) {
      record.deliveryStatus = "sent";
      record.deliveredAt = sentAt;
    }
  }

  async markDigestFailed(
    digestId: string,
    leaseOwner: string,
    nextAttemptAt: Date,
    _errorCode: string,
  ): Promise<void> {
    const digest = this.requiredDigest(digestId, leaseOwner);
    digest.status = "failed";
    digest.leaseOwner = null;
    digest.leaseExpiresAt = null;
    digest.nextAttemptAt = nextAttemptAt;
    for (const record of digest.feedback) {
      record.deliveryStatus = "failed";
      record.deliveredAt = null;
    }
  }

  private requiredDigest(id: string, leaseOwner: string): MemoryDigestRun {
    const digest = this.digests.find(
      (candidate) =>
        candidate.id === id &&
        candidate.status === "sending" &&
        candidate.leaseOwner === leaseOwner,
    );
    if (!digest) throw new Error("Feedback digest lease lost");
    return digest;
  }

  private publicClaim(digest: MemoryDigestRun): FeedbackDigestClaim {
    return {
      id: digest.id,
      cutoffAt: digest.cutoffAt,
      messageId: digest.messageId,
      attemptCount: digest.attemptCount,
      feedback: [...digest.feedback],
    };
  }
}
