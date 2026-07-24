import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
} from "drizzle-orm";
import type {
  ClaimFeedbackDigestInput,
  FeedbackDigestClaim,
} from "../../feedback/types.js";
import type { AppDatabase } from "../client.js";
import {
  feedback,
  feedbackDigestRuns,
  type FeedbackRow,
  type NewFeedbackRow,
} from "../schema.js";

function requiredRow<T>(row: T | undefined, operation: string): T {
  if (!row) {
    throw new Error(`数据库操作未返回记录：${operation}`);
  }
  return row;
}

export class FeedbackRepository {
  constructor(private readonly db: AppDatabase) {}

  async create(input: NewFeedbackRow): Promise<FeedbackRow> {
    const [row] = await this.db.insert(feedback).values(input).returning();
    return requiredRow(row, "createFeedback");
  }

  async claimDigest(
    input: ClaimFeedbackDigestInput,
  ): Promise<FeedbackDigestClaim | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(feedbackDigestRuns)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: input.now,
          lastErrorCode: "LEASE_EXPIRED",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(feedbackDigestRuns.status, "sending"),
            lte(feedbackDigestRuns.leaseExpiresAt, input.now),
          ),
        );

      const [retry] = await tx
        .select()
        .from(feedbackDigestRuns)
        .where(
          and(
            inArray(feedbackDigestRuns.status, ["pending", "failed"]),
            lte(feedbackDigestRuns.nextAttemptAt, input.now),
          ),
        )
        .orderBy(asc(feedbackDigestRuns.cutoffAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (retry) {
        const [claimed] = await tx
          .update(feedbackDigestRuns)
          .set({
            status: "sending",
            attemptCount: retry.attemptCount + 1,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: new Date(
              input.now.getTime() + input.leaseMs,
            ),
            lastErrorCode: null,
            updatedAt: input.now,
          })
          .where(eq(feedbackDigestRuns.id, retry.id))
          .returning();
        return this.buildClaim(
          requiredRow(claimed, "claimFeedbackDigestRetry"),
          await tx
            .select()
            .from(feedback)
            .where(eq(feedback.digestRunId, retry.id))
            .orderBy(asc(feedback.createdAt), asc(feedback.id)),
        );
      }

      const [openRun] = await tx
        .select({ id: feedbackDigestRuns.id })
        .from(feedbackDigestRuns)
        .where(
          inArray(feedbackDigestRuns.status, [
            "pending",
            "sending",
            "failed",
          ]),
        )
        .limit(1);
      if (openRun) return null;

      const digestId = randomUUID();
      const [created] = await tx
        .insert(feedbackDigestRuns)
        .values({
          id: digestId,
          cutoffAt: input.cutoffAt,
          messageId: `<feedback-digest-${digestId}@turing-game.local>`,
          status: "sending",
          attemptCount: 1,
          nextAttemptAt: input.now,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: new Date(
            input.now.getTime() + input.leaseMs,
          ),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: feedbackDigestRuns.cutoffAt,
        })
        .returning();
      if (!created) return null;

      const assigned = await tx
        .update(feedback)
        .set({ digestRunId: digestId })
        .where(
          and(
            isNull(feedback.digestRunId),
            inArray(feedback.deliveryStatus, ["pending", "failed"]),
            lte(feedback.createdAt, input.cutoffAt),
          ),
        )
        .returning({ id: feedback.id });
      if (assigned.length === 0) {
        await tx
          .delete(feedbackDigestRuns)
          .where(eq(feedbackDigestRuns.id, digestId));
        return null;
      }
      const members = await tx
        .select()
        .from(feedback)
        .where(eq(feedback.digestRunId, digestId))
        .orderBy(asc(feedback.createdAt), asc(feedback.id));
      return this.buildClaim(created, members);
    });
  }

  async markDigestSent(
    digestId: string,
    leaseOwner: string,
    sentAt: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .update(feedbackDigestRuns)
        .set({
          status: "sent",
          sentAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          updatedAt: sentAt,
        })
        .where(
          and(
            eq(feedbackDigestRuns.id, digestId),
            eq(feedbackDigestRuns.status, "sending"),
            eq(feedbackDigestRuns.leaseOwner, leaseOwner),
          ),
        )
        .returning({ id: feedbackDigestRuns.id });
      requiredRow(run, "markFeedbackDigestSent");
      await tx
        .update(feedback)
        .set({ deliveryStatus: "sent", deliveredAt: sentAt })
        .where(eq(feedback.digestRunId, digestId));
    });
  }

  async markDigestFailed(
    digestId: string,
    leaseOwner: string,
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .update(feedbackDigestRuns)
        .set({
          status: "failed",
          nextAttemptAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode.slice(0, 80),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(feedbackDigestRuns.id, digestId),
            eq(feedbackDigestRuns.status, "sending"),
            eq(feedbackDigestRuns.leaseOwner, leaseOwner),
          ),
        )
        .returning({ id: feedbackDigestRuns.id });
      requiredRow(run, "markFeedbackDigestFailed");
      await tx
        .update(feedback)
        .set({ deliveryStatus: "failed", deliveredAt: null })
        .where(eq(feedback.digestRunId, digestId));
    });
  }

  private buildClaim(
    run: typeof feedbackDigestRuns.$inferSelect,
    members: FeedbackRow[],
  ): FeedbackDigestClaim {
    return {
      id: run.id,
      cutoffAt: run.cutoffAt,
      messageId: run.messageId,
      attemptCount: run.attemptCount,
      feedback: members,
    };
  }
}
