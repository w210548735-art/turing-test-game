import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../client.js";
import {
  gameParticipants,
  games,
  guesses,
  messages,
  settlements,
  users,
  type GameParticipantRow,
  type GameRow,
  type GuessRow,
  type MessageRow,
  type NewGameParticipantRow,
  type NewGameRow,
  type NewMessageRow,
  type SettlementRow,
  type UserRow,
} from "../schema.js";

export interface UpsertGuestInput {
  sessionTokenHash: string;
  nickname: string;
  typingStatus: string;
}

export interface UpdateUserProfileInput {
  userId: string;
  nickname: string;
  typingStatus: string;
}

export interface SubmitGuessInput {
  gameId: string;
  participantId: string;
  targetGuess: "human" | "ai";
  submittedAt?: Date;
}

export interface SettlementParticipantInput {
  settlementId: string;
  participantId: string;
  userId?: string | null;
  opponentType: "human" | "ai";
  playerGuess?: "human" | "ai" | null;
  correct?: boolean | null;
  outcome: "won" | "lost" | "draw" | "cancelled";
  scoreDelta: number;
  durationMs: number;
}

export interface SettleGameInput {
  gameId: string;
  reason:
    | "all_guessed"
    | "player_guessed"
    | "timeout"
    | "disconnect"
    | "cancelled";
  settledAt?: Date;
  participants: SettlementParticipantInput[];
}

export interface GameSnapshot {
  game: GameRow;
  participants: GameParticipantRow[];
  messages: MessageRow[];
  guesses: GuessRow[];
  settlements: SettlementRow[];
}

function requiredRow<T>(row: T | undefined, operation: string): T {
  if (!row) {
    throw new Error(`数据库操作未返回记录：${operation}`);
  }
  return row;
}

export class GameRepository {
  constructor(private readonly db: AppDatabase) {}

  async upsertGuest(input: UpsertGuestInput): Promise<UserRow> {
    const [row] = await this.db
      .insert(users)
      .values(input)
      .onConflictDoUpdate({
        target: users.sessionTokenHash,
        set: {
          nickname: input.nickname,
          typingStatus: input.typingStatus,
          lastSeenAt: new Date(),
        },
      })
      .returning();
    return requiredRow(row, "upsertGuest");
  }

  async updateUserProfile(
    input: UpdateUserProfileInput,
  ): Promise<UserRow> {
    const [row] = await this.db
      .update(users)
      .set({
        nickname: input.nickname,
        typingStatus: input.typingStatus,
        lastSeenAt: new Date(),
      })
      .where(eq(users.id, input.userId))
      .returning();
    return requiredRow(row, "updateUserProfile");
  }

  async createGame(input: NewGameRow): Promise<GameRow> {
    const [row] = await this.db.insert(games).values(input).returning();
    return requiredRow(row, "createGame");
  }

  async addParticipant(
    input: NewGameParticipantRow,
  ): Promise<GameParticipantRow> {
    const [row] = await this.db
      .insert(gameParticipants)
      .values(input)
      .returning();
    return requiredRow(row, "addParticipant");
  }

  /**
   * 写入聊天消息。存在 clientMessageId 时，重复提交返回首次写入的消息，
   * 避免断线重发造成重复内容。
   */
  async appendMessage(input: NewMessageRow): Promise<MessageRow> {
    const [inserted] = await this.db
      .insert(messages)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return inserted;
    }
    if (input.clientMessageId) {
      const [existing] = await this.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.gameId, input.gameId),
            eq(messages.clientMessageId, input.clientMessageId),
          ),
        )
        .limit(1);
      return requiredRow(existing, "appendMessage 幂等读取");
    }
    throw new Error("消息序号冲突，且没有 clientMessageId 可用于幂等读取。");
  }

  async submitGuess(input: SubmitGuessInput): Promise<GuessRow> {
    const [inserted] = await this.db
      .insert(guesses)
      .values(input)
      .onConflictDoNothing({
        target: [guesses.gameId, guesses.participantId],
      })
      .returning();
    if (inserted) {
      return inserted;
    }
    const [existing] = await this.db
      .select()
      .from(guesses)
      .where(
        and(
          eq(guesses.gameId, input.gameId),
          eq(guesses.participantId, input.participantId),
        ),
      )
      .limit(1);
    return requiredRow(existing, "submitGuess 幂等读取");
  }

  /**
   * 结算记录与用户计分在同一事务内完成。
   * 只有首次插入 settlement 的参与者会更新累计数据。
   */
  async settleGame(input: SettleGameInput): Promise<SettlementRow[]> {
    const settledAt = input.settledAt ?? new Date();
    return this.db.transaction(async (transaction) => {
      await transaction
        .update(games)
        .set({
          status: input.reason === "cancelled" ? "cancelled" : "settled",
          settledAt,
          updatedAt: settledAt,
        })
        .where(eq(games.id, input.gameId));

      const result: SettlementRow[] = [];
      for (const participant of input.participants) {
        const [inserted] = await transaction
          .insert(settlements)
          .values({
            settlementId: participant.settlementId,
            gameId: input.gameId,
            participantId: participant.participantId,
            reason: input.reason,
            opponentType: participant.opponentType,
            playerGuess: participant.playerGuess,
            correct: participant.correct,
            outcome: participant.outcome,
            scoreDelta: participant.scoreDelta,
            durationMs: participant.durationMs,
            createdAt: settledAt,
          })
          .onConflictDoNothing({
            target: [settlements.gameId, settlements.participantId],
          })
          .returning();

        if (!inserted) {
          const [existing] = await transaction
            .select()
            .from(settlements)
            .where(
              and(
                eq(settlements.gameId, input.gameId),
                eq(settlements.participantId, participant.participantId),
              ),
            )
            .limit(1);
          result.push(requiredRow(existing, "settleGame 幂等读取"));
          continue;
        }

        result.push(inserted);
        if (participant.userId) {
          await transaction
            .update(users)
            .set({
              score: sql`${users.score} + ${participant.scoreDelta}`,
              gamesPlayed: sql`${users.gamesPlayed} + 1`,
              correctGuesses:
                participant.correct === true
                  ? sql`${users.correctGuesses} + 1`
                  : users.correctGuesses,
              currentStreak:
                participant.correct === true
                  ? sql`${users.currentStreak} + 1`
                  : 0,
              lastSeenAt: settledAt,
            })
            .where(eq(users.id, participant.userId));
        }
      }
      return result;
    });
  }

  async getSnapshot(gameId: string): Promise<GameSnapshot | null> {
    const [game] = await this.db
      .select()
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1);
    if (!game) {
      return null;
    }

    const [participants, gameMessages, gameGuesses, gameSettlements] =
      await Promise.all([
        this.db
          .select()
          .from(gameParticipants)
          .where(eq(gameParticipants.gameId, gameId))
          .orderBy(asc(gameParticipants.seat)),
        this.db
          .select()
          .from(messages)
          .where(eq(messages.gameId, gameId))
          .orderBy(asc(messages.serverSequence)),
        this.db
          .select()
          .from(guesses)
          .where(eq(guesses.gameId, gameId))
          .orderBy(asc(guesses.submittedAt)),
        this.db
          .select()
          .from(settlements)
          .where(eq(settlements.gameId, gameId))
          .orderBy(asc(settlements.createdAt)),
      ]);

    return {
      game,
      participants,
      messages: gameMessages,
      guesses: gameGuesses,
      settlements: gameSettlements,
    };
  }
}
