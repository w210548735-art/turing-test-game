import type { FeedbackCategory } from "@turing-game/protocol";

export interface FeedbackRecord {
  id: string;
  userId: string | null;
  category: FeedbackCategory;
  title: string;
  details: string;
  deliveryStatus: "pending" | "sent" | "failed";
  deliveredAt: Date | null;
  digestRunId: string | null;
  createdAt: Date;
}

export interface NewFeedback {
  userId: string;
  category: FeedbackCategory;
  title: string;
  details: string;
}

export interface FeedbackDigestClaim {
  id: string;
  cutoffAt: Date;
  messageId: string;
  attemptCount: number;
  feedback: FeedbackRecord[];
}

export interface ClaimFeedbackDigestInput {
  cutoffAt: Date;
  now: Date;
  leaseOwner: string;
  leaseMs: number;
}

export interface FeedbackRepositoryPort {
  create(input: NewFeedback): Promise<FeedbackRecord>;
  claimDigest(
    input: ClaimFeedbackDigestInput,
  ): Promise<FeedbackDigestClaim | null>;
  markDigestSent(
    digestId: string,
    leaseOwner: string,
    sentAt: Date,
  ): Promise<void>;
  markDigestFailed(
    digestId: string,
    leaseOwner: string,
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<void>;
}

export interface FeedbackDigestEmailMessage {
  to: string;
  digest: FeedbackDigestClaim;
}

export interface FeedbackEmailDelivery {
  sendFeedbackDigest(message: FeedbackDigestEmailMessage): Promise<void>;
}
