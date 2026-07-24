import {
  and,
  inArray,
  isNotNull,
  lt,
  or,
} from "drizzle-orm";
import type { AppDatabase } from "./client.js";
import {
  bans,
  messages,
  moderationEvents,
  reports,
} from "./schema.js";

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionResult {
  messagesDeleted: number;
  reportsDeleted: number;
  moderationEventsDeleted: number;
  bansDeleted: number;
}

/**
 * 封闭 Alpha 的最小数据保留任务。
 * 未完成审核的举报不会自动删除，避免破坏安全处置证据。
 */
export async function runRetentionJobs(
  database: AppDatabase,
  now = new Date(),
): Promise<RetentionResult> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * DAY_MS);
  const oneHundredEightyDaysAgo = new Date(
    now.getTime() - 180 * DAY_MS,
  );

  const [
    deletedMessages,
    deletedReports,
    deletedModerationEvents,
    deletedBans,
  ] = await database.transaction(async (transaction) => {
    const removedMessages = await transaction
      .delete(messages)
      .where(lt(messages.createdAt, sevenDaysAgo))
      .returning({ id: messages.id });
    const removedReports = await transaction
      .delete(reports)
      .where(
        and(
          inArray(reports.status, ["resolved", "dismissed"]),
          lt(reports.createdAt, ninetyDaysAgo),
        ),
      )
      .returning({ id: reports.id });
    const removedModerationEvents = await transaction
      .delete(moderationEvents)
      .where(
        lt(moderationEvents.createdAt, oneHundredEightyDaysAgo),
      )
      .returning({ id: moderationEvents.id });
    const removedBans = await transaction
      .delete(bans)
      .where(
        and(
          lt(bans.createdAt, oneHundredEightyDaysAgo),
          or(isNotNull(bans.revokedAt), lt(bans.expiresAt, now)),
        ),
      )
      .returning({ id: bans.id });
    return [
      removedMessages,
      removedReports,
      removedModerationEvents,
      removedBans,
    ] as const;
  });

  return {
    messagesDeleted: deletedMessages.length,
    reportsDeleted: deletedReports.length,
    moderationEventsDeleted: deletedModerationEvents.length,
    bansDeleted: deletedBans.length,
  };
}
