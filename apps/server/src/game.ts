import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { requestAiReply } from "./ai.js";
import type {
  AiReserveRequest,
  AiSettleRequest,
  AiSettlementOutcome,
  AiUsageBudgetService,
} from "./ai/usage-budget.js";
import type { GameRepository } from "./db/repositories/game-repository.js";
import type { ReportRepository as DatabaseReportRepository } from "./db/repositories/report-repository.js";
import type { EchoArchiveService } from "./echo/index.js";
import { AppError } from "./errors.js";
import type { AiBudgetController } from "./matchmaking/ai-budget.js";
import {
  ModerationPipeline,
  type ModerationDecision,
} from "./moderation/index.js";
import type { RoomSnapshotStore } from "./rooms/room-store.js";
import {
  moderateAiOutput,
  validateReportReason,
} from "./security.js";
import type {
  ChatMessage,
  Guess,
  Participant,
  ReportRecord,
  Room,
  Session,
  SettlementView,
  WsEnvelope,
} from "./types.js";

export const ENTRY_GATE_MS = 5_000;
export const MATCH_SEARCH_MIN_MS = 5_000;
export const DEFAULT_MAX_CONCURRENT_ROOMS = 50;
export const DEFAULT_MAX_QUEUE_SIZE = 500;
export const GUESS_UNLOCK_MS = 20_000;
export const ROOM_DURATION_MS = 5 * 60_000;
export const DISCONNECT_GRACE_MS = 30_000;
export const TYPING_EXPIRY_MS = 3_000;
export const MAX_MESSAGES_PER_PLAYER = 20;
export const AI_RATIO_TARGET = 0.25;
export const AI_USAGE_ESTIMATED_TOKENS = 2_048;
const AI_USAGE_ESTIMATED_PROMPT_TOKENS = 1_848;
const AI_USAGE_MAX_COMPLETION_TOKENS = 200;

type GameAiUsageBudget = Pick<AiUsageBudgetService, "reserve" | "settle">;

interface QueuedPlayer {
  session: Session;
  joinedAt: number;
  searchStartedAt?: number;
  searchTimer?: NodeJS.Timeout;
}

interface PendingAdmission {
  id: string;
  players: QueuedPlayer[];
  opponentType: "human" | "ai";
  revealAt: number;
  gateEndsAt: number;
  revealTimer?: NodeJS.Timeout;
  gateTimer?: NodeJS.Timeout;
}

export interface GameServiceOptions {
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  aiReply?: typeof requestAiReply;
  onMetric?: (metric: MatchMetrics) => void;
  aiBudget?: AiBudgetController;
  aiUsageBudget?: GameAiUsageBudget;
  roomStore?: RoomSnapshotStore;
  gameRepository?: GameRepository;
  reportRepository?: DatabaseReportRepository;
  echoArchiveService?: Pick<
    EchoArchiveService,
    | "appendTimelineEvent"
    | "initializeArchiveCandidate"
    | "withdrawForReport"
  >;
  moderation?: ModerationPipeline;
  onModerationDecision?: (
    decision: ModerationDecision,
    session: Session,
    room: Room,
  ) => void | Promise<void>;
  onPersistenceError?: (error: unknown, operation: string) => void;
  maxConcurrentRooms?: number;
  maxQueueSize?: number;
}

export interface MatchMetrics {
  recentGames: number;
  aiGames: number;
  aiRatio: number;
  target: number;
  aboveTarget: boolean;
}

export class GameService {
  readonly rooms = new Map<string, Room>();
  readonly reports = new Map<string, ReportRecord>();

  private readonly capacityQueue: QueuedPlayer[] = [];
  private readonly searching: QueuedPlayer[] = [];
  private readonly admissions = new Map<string, PendingAdmission>();
  private readonly recentMatchTypes: Array<"human" | "ai"> = [];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly aiReply: typeof requestAiReply;
  private readonly onMetric?: (metric: MatchMetrics) => void;
  private readonly aiBudget?: AiBudgetController;
  private readonly aiUsageBudget?: GameAiUsageBudget;
  private readonly roomStore?: RoomSnapshotStore;
  private readonly gameRepository?: GameRepository;
  private readonly reportRepository?: DatabaseReportRepository;
  private readonly echoArchiveService?: GameServiceOptions["echoArchiveService"];
  private readonly moderation: ModerationPipeline;
  private readonly onModerationDecision?: GameServiceOptions["onModerationDecision"];
  private readonly onPersistenceError?: GameServiceOptions["onPersistenceError"];
  private readonly maxConcurrentRooms: number;
  private readonly maxQueueSize: number;
  private stopping = false;

  constructor(options: GameServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.aiReply = options.aiReply ?? requestAiReply;
    this.onMetric = options.onMetric;
    this.aiBudget = options.aiBudget;
    this.aiUsageBudget = options.aiUsageBudget;
    this.roomStore = options.roomStore;
    this.gameRepository = options.gameRepository;
    this.reportRepository = options.reportRepository;
    this.echoArchiveService = options.echoArchiveService;
    this.moderation = options.moderation ?? new ModerationPipeline();
    this.onModerationDecision = options.onModerationDecision;
    this.onPersistenceError = options.onPersistenceError;
    this.maxConcurrentRooms =
      options.maxConcurrentRooms ?? DEFAULT_MAX_CONCURRENT_ROOMS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    if (
      !Number.isInteger(this.maxConcurrentRooms) ||
      this.maxConcurrentRooms <= 0
    ) {
      throw new Error("maxConcurrentRooms 必须是正整数。");
    }
    if (!Number.isInteger(this.maxQueueSize) || this.maxQueueSize <= 0) {
      throw new Error("maxQueueSize 必须是正整数。");
    }
  }

  joinQueue(session: Session): void {
    if (!session.socket || session.socket.readyState !== session.socket.OPEN) {
      throw new AppError("SOCKET_NOT_READY", "连接尚未准备好。");
    }
    if (session.roomId && this.rooms.get(session.roomId)?.status === "active") {
      throw new AppError("ALREADY_IN_ROOM", "你已经在一个对局中。");
    }
    if (this.isWaiting(session.userId)) {
      throw new AppError("ALREADY_QUEUED", "你已经在匹配队列中。");
    }

    const queued: QueuedPlayer = {
      session,
      joinedAt: this.now(),
    };
    if (this.canEnterSearch()) {
      this.startSearching(queued);
      return;
    }
    if (this.capacityQueue.length >= this.maxQueueSize) {
      throw new AppError(
        "MATCH_QUEUE_FULL",
        "当前等待人数较多，请稍后再试。",
        503,
      );
    }
    this.capacityQueue.push(queued);
    this.broadcastQueuePositions();
  }

  leaveQueue(session: Session): void {
    const capacityIndex = this.capacityQueue.findIndex(
      (queued) => queued.session.userId === session.userId,
    );
    if (capacityIndex >= 0) {
      this.capacityQueue.splice(capacityIndex, 1);
      this.broadcastQueuePositions();
      this.promoteCapacityQueue();
      return;
    }

    const searching = this.searching.find(
      (queued) => queued.session.userId === session.userId,
    );
    if (searching) {
      this.removeSearching(searching);
      this.promoteCapacityQueue();
      return;
    }

    const admission = [...this.admissions.values()].find((candidate) =>
      candidate.players.some(
        (queued) => queued.session.userId === session.userId,
      ),
    );
    if (admission) {
      this.cancelAdmission(admission, session.userId);
    }
  }

  reconnect(session: Session, socket: WebSocket): void {
    session.socket = socket;
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room || room.status !== "active") {
      return;
    }
    const participant = this.participantFor(room, session.userId);
    participant.connected = true;
    if (participant.disconnectTimer) {
      this.clearTimer(participant.disconnectTimer);
      participant.disconnectTimer = undefined;
    }
    this.send(session, {
      type: "game.reconnected",
      message: "连接已恢复。",
    });
    this.send(session, {
      type: "match.found",
      gameId: room.id,
      startedAt: room.createdAt,
      endsAt: room.expiresAt,
      minGuessAt: room.createdAt + GUESS_UNLOCK_MS,
      opponentLabel: `匿名玩家 / ${room.id.slice(0, 2).toUpperCase()}`,
    });
  }

  handleDisconnect(session: Session): void {
    this.leaveQueue(session);
    if (this.stopping) {
      return;
    }
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room || room.status !== "active") {
      return;
    }
    const participant = this.participantFor(room, session.userId);
    participant.connected = false;
    room.hadDisconnect = true;
    this.broadcastToOthers(room, session.userId, {
      type: "game.disconnected",
      message: "对方连接中断，正在等待恢复。",
    });
    participant.disconnectTimer = this.setTimer(() => {
      if (participant.connected || room.status !== "active") {
        return;
      }
      this.settle(room, "disconnect");
    }, DISCONNECT_GRACE_MS);
  }

  sendChat(
    session: Session,
    rawText: unknown,
    clientMessageId?: string,
  ): ChatMessage {
    const room = this.requireAuthorizedRoom(session);
    const participant = this.participantFor(room, session.userId);
    if (clientMessageId) {
      const existing = room.messages.find(
        (message) =>
          message.senderId === session.userId &&
          message.clientMessageId === clientMessageId,
      );
      if (existing) {
        this.sendChatMessage(session, existing, false);
        return existing;
      }
    }
    if (participant.guess) {
      throw new AppError(
        "GUESS_ALREADY_LOCKED",
        "判断锁定后不能继续发送消息。",
      );
    }
    if (participant.messageCount >= MAX_MESSAGES_PER_PLAYER) {
      throw new AppError(
        "MESSAGE_LIMIT_REACHED",
        "本局每位玩家最多发送 20 条消息。",
      );
    }
    const messageId = randomUUID();
    const receivedAt = this.now();
    const moderation = this.moderation.evaluate({
      text: rawText,
      surface: "CHAT",
      audit: {
        actorId: session.userId,
        ipHash: session.ipHash,
      },
    });
    void this.onModerationDecision?.(moderation, session, room);
    if (moderation.action === "TERMINATE") {
      this.settle(room, "disconnect");
      throw new AppError(
        "SAFETY_TERMINATED",
        moderation.userMessage ?? "检测到高风险内容，本局已结束。",
      );
    }
    if (moderation.action === "BLOCK") {
      throw new AppError(
        "CONTENT_BLOCKED",
        moderation.userMessage ?? "该内容不适合匿名聊天，消息未发送。",
      );
    }
    const text = moderation.text;
    const replaced = moderation.action === "REDACT";
    const visibleAt = this.now();
    const message: ChatMessage = {
      id: messageId,
      senderId: session.userId,
      sender: "self",
      text,
      at: visibleAt,
      sequence: room.messages.length + 1,
      clientMessageId,
      moderated: replaced,
    };
    participant.messageCount += 1;
    room.messages.push(message);
    this.persistMessage(room, message);
    this.persistTimelineEvent(room, {
      eventType: "message_received",
      actorParticipantId: participant.databaseParticipantId,
      messageId,
      occurredAt: receivedAt,
      moderated: replaced,
    });
    this.persistTimelineEvent(room, {
      eventType: "message_visible",
      actorParticipantId: participant.databaseParticipantId,
      messageId,
      occurredAt: visibleAt,
      moderated: replaced,
    });
    this.broadcastMessage(room, message, replaced);
    if (room.opponentType === "ai") {
      this.scheduleAiReply(room);
    }
    return message;
  }

  setTyping(session: Session, active: unknown): void {
    if (typeof active !== "boolean") {
      throw new AppError("INVALID_TYPING_STATE", "输入状态格式无效。");
    }
    const room = this.requireAuthorizedRoom(session);
    const participant = this.participantFor(room, session.userId);
    const now = this.now();
    if (participant.typingExpiry) {
      this.clearTimer(participant.typingExpiry);
      participant.typingExpiry = undefined;
    }
    if (active) {
      const firstTransition = !participant.typingActive;
      if (firstTransition) {
        participant.typingActive = true;
        this.persistTimelineEvent(room, {
          eventType: "typing_start",
          actorParticipantId: participant.databaseParticipantId,
          occurredAt: now,
        });
        this.broadcastToOthers(room, session.userId, {
          type: "chat.typing_start",
          status: session.profile.typingStatus,
        });
      }
      participant.typingExpiry = this.setTimer(() => {
        this.stopParticipantTyping(room, participant);
      }, TYPING_EXPIRY_MS);
      return;
    }
    this.stopParticipantTyping(room, participant);
  }

  submitGuess(
    session: Session,
    rawGuess: unknown,
    clientGuessId?: string,
  ): SettlementView | null {
    const room = this.requireAuthorizedRoom(session);
    if (this.now() < room.createdAt + GUESS_UNLOCK_MS) {
      throw new AppError(
        "GUESS_LOCKED",
        "对局开始 20 秒后才能提交判断。",
      );
    }
    if (rawGuess !== "human" && rawGuess !== "ai") {
      throw new AppError("INVALID_GUESS", "判断必须是 human 或 ai。");
    }
    const participant = this.participantFor(room, session.userId);
    if (participant.guess) {
      if (
        clientGuessId &&
        participant.guessClientId === clientGuessId &&
        participant.guess === rawGuess
      ) {
        this.send(session, {
          type: "guess.accepted",
          targetGuess: participant.guess,
        });
        return null;
      }
      throw new AppError("GUESS_ALREADY_LOCKED", "你的判断已经锁定。");
    }
    participant.guess = rawGuess;
    participant.guessClientId = clientGuessId;
    this.persistGuess(room, participant);
    this.send(session, {
      type: "guess.accepted",
      targetGuess: rawGuess,
    });

    if (room.opponentType === "ai") {
      return this.settle(room, "player_guessed")[0]?.view ?? null;
    }
    if (room.participants.every((candidate) => candidate.guess !== null)) {
      const results = this.settle(room, "all_guessed");
      return (
        results.find((result) => result.userId === session.userId)?.view ?? null
      );
    }
    return null;
  }

  async createReport(
    session: Session,
    rawReason: unknown,
  ): Promise<ReportRecord> {
    const room = this.requireOwnedRoom(session);
    const reason = validateReportReason(rawReason);
    const reportedParticipant = room.participants.find(
      (participant) => participant.session.userId !== session.userId,
    );
    const report: ReportRecord = {
      id: randomUUID(),
      reporterId: session.userId,
      roomId: room.id,
      reportedUserId:
        reportedParticipant?.session.userId ?? `ai:${room.id}`,
      reportedParticipantId:
        reportedParticipant?.databaseParticipantId ??
        room.aiDatabaseParticipantId,
      reason,
      createdAt: this.now(),
      evidence: {
        opponentType: room.opponentType,
        messages: room.messages.slice(-50).map((message) => ({ ...message })),
      },
    };
    if (this.reportRepository) {
      await room.persistenceChain;
      await this.reportRepository.create({
        id: report.id,
        gameId: room.id,
        reporterUserId: session.databaseUserId,
        reportedParticipantId: report.reportedParticipantId,
        reason: report.reason,
        evidence: {
          opponentType: room.opponentType,
          messageIds: report.evidence.messages.map((message) => message.id),
          snapshot: report.evidence.messages.map((message) => ({
            id: message.id,
            sender:
              message.senderId === session.userId ? "self" : "opponent",
            text: message.text,
            at: message.at,
            sequence: message.sequence,
          })),
        },
      });
    }
    await this.echoArchiveService?.withdrawForReport(room.id, this.now());
    this.reports.set(report.id, report);
    return report;
  }

  leaveGame(session: Session): void {
    const room = this.requireOwnedRoom(session);
    if (room.status !== "active") {
      return;
    }
    this.broadcastToOthers(room, session.userId, {
      type: "game.disconnected",
      message: "对方已离开本局。",
    });
    this.settle(room, "disconnect");
  }

  async resumeRoom(session: Session, lastSequence: number): Promise<void> {
    const room = this.requireOwnedRoom(session);
    if (this.roomStore) {
      await room.persistenceChain;
      const bundle = await this.roomStore.getResumeBundle(
        room.id,
        lastSequence,
      );
      if (bundle) {
        this.send(session, {
          type: "game.snapshot",
          gameId: room.id,
          status: bundle.snapshot.status,
          lastSequence: bundle.snapshot.lastSequence,
          messages: bundle.messages.map((message) => ({
            id: message.id,
            sender:
              message.senderId === session.userId ? "self" : "opponent",
            content: message.text,
            sequence: message.sequence,
            createdAt: message.at,
            moderated: message.metadata?.moderated === true,
          })),
        });
        return;
      }
    }
    const messages = room.messages
      .filter((message) => message.sequence > lastSequence)
      .map((message) => {
        const view = this.messageFor(message, session.userId);
        return {
          id: view.id,
          sender: view.sender,
          content: view.text,
          sequence: view.sequence,
          createdAt: view.at,
        };
      });
    this.send(session, {
      type: "game.snapshot",
      gameId: room.id,
      status: room.status,
      lastSequence: room.messages.at(-1)?.sequence ?? 0,
      messages,
    });
  }

  getMetrics(): MatchMetrics {
    const aiGames = this.recentMatchTypes.filter(
      (type) => type === "ai",
    ).length;
    const aiRatio = this.recentMatchTypes.length
      ? aiGames / this.recentMatchTypes.length
      : 0;
    return {
      recentGames: this.recentMatchTypes.length,
      aiGames,
      aiRatio,
      target: AI_RATIO_TARGET,
      aboveTarget: aiRatio > AI_RATIO_TARGET,
    };
  }

  shutdown(): void {
    this.stopping = true;
    for (const queued of this.searching) {
      if (queued.searchTimer) this.clearTimer(queued.searchTimer);
    }
    this.capacityQueue.length = 0;
    this.searching.length = 0;
    for (const admission of this.admissions.values()) {
      if (admission.revealTimer) {
        this.clearTimer(admission.revealTimer);
      }
      if (admission.gateTimer) {
        this.clearTimer(admission.gateTimer);
      }
    }
    this.admissions.clear();
    for (const room of this.rooms.values()) {
      this.cancelAi(room);
      if (room.expiryTimer) this.clearTimer(room.expiryTimer);
      for (const participant of room.participants) {
        if (participant.disconnectTimer) {
          this.clearTimer(participant.disconnectTimer);
        }
        if (participant.typingExpiry) {
          this.clearTimer(participant.typingExpiry);
        }
      }
    }
  }

  private isWaiting(userId: string): boolean {
    return (
      this.capacityQueue.some(
        (queued) => queued.session.userId === userId,
      ) ||
      this.searching.some(
        (queued) => queued.session.userId === userId,
      ) ||
      [...this.admissions.values()].some((admission) =>
        admission.players.some(
          (queued) => queued.session.userId === userId,
        ),
      )
    );
  }

  private occupiedRoomSlots(): number {
    const activeRooms = [...this.rooms.values()].filter(
      (room) => room.status === "active",
    ).length;
    return activeRooms + this.admissions.size;
  }

  private canEnterSearch(): boolean {
    const freeRoomSlots =
      this.maxConcurrentRooms - this.occupiedRoomSlots();
    return (
      freeRoomSlots > 0 &&
      this.searching.length < freeRoomSlots * 2
    );
  }

  private startSearching(
    queued: QueuedPlayer,
    searchStartedAt = this.now(),
  ): void {
    queued.searchStartedAt = searchStartedAt;
    this.searching.push(queued);
    this.send(queued.session, {
      type: "match.searching",
      searchStartedAt,
    });
    queued.searchTimer = this.setTimer(
      () => this.fillWithAiIfStillWaiting(queued),
      MATCH_SEARCH_MIN_MS,
    );
    this.tryReserveHumans();
  }

  private broadcastQueuePositions(): void {
    this.capacityQueue.forEach((queued, index) => {
      this.send(queued.session, {
        type: "match.queued",
        position: index + 1,
        queuedAt: queued.joinedAt,
      });
    });
  }

  private promoteCapacityQueue(): void {
    if (this.stopping) {
      return;
    }
    while (this.capacityQueue.length > 0 && this.canEnterSearch()) {
      const queued = this.capacityQueue.shift();
      if (!queued) {
        break;
      }
      if (
        !queued.session.socket ||
        queued.session.socket.readyState !== queued.session.socket.OPEN
      ) {
        continue;
      }
      this.startSearching(queued);
    }
    this.broadcastQueuePositions();
  }

  private tryReserveHumans(): void {
    while (
      this.searching.length >= 2 &&
      this.occupiedRoomSlots() < this.maxConcurrentRooms
    ) {
      const first = this.searching[0];
      const second = this.searching[1];
      if (!first || !second) {
        break;
      }
      this.reserveAdmission([first, second], "human");
    }
  }

  private fillWithAiIfStillWaiting(queued: QueuedPlayer): void {
    if (!this.searching.includes(queued)) {
      return;
    }
    const human = this.searching.find(
      (candidate) =>
        candidate !== queued &&
        Boolean(candidate.session.socket),
    );
    if (human) {
      this.reserveAdmission([queued, human], "human");
      return;
    }
    if (!this.aiBudget) {
      this.reserveAdmission([queued], "ai");
      return;
    }
    void this.aiBudget
      .reserveAiGame()
      .then((decision) => {
        if (!this.searching.includes(queued)) return;
        if (decision.allowed) {
          this.reserveAdmission([queued], "ai");
          return;
        }
        this.tryReserveHumans();
        if (this.searching.includes(queued)) {
          queued.searchTimer = this.setTimer(
            () => this.fillWithAiIfStillWaiting(queued),
            MATCH_SEARCH_MIN_MS,
          );
        }
      })
      .catch((error) => {
        this.onPersistenceError?.(error, "reserve_ai_budget");
        if (this.searching.includes(queued)) {
          queued.searchTimer = this.setTimer(
            () => this.fillWithAiIfStillWaiting(queued),
            MATCH_SEARCH_MIN_MS,
          );
        }
      });
  }

  private reserveAdmission(
    players: QueuedPlayer[],
    opponentType: "human" | "ai",
  ): void {
    if (
      players.some((queued) => !this.searching.includes(queued)) ||
      this.occupiedRoomSlots() >= this.maxConcurrentRooms
    ) {
      return;
    }
    for (const queued of players) {
      this.removeSearching(queued);
    }
    const revealAt = Math.max(
      ...players.map(
        (queued) =>
          (queued.searchStartedAt ?? this.now()) + MATCH_SEARCH_MIN_MS,
      ),
    );
    const admission: PendingAdmission = {
      id: randomUUID(),
      players,
      opponentType,
      revealAt,
      gateEndsAt: revealAt + ENTRY_GATE_MS,
    };
    this.admissions.set(admission.id, admission);
    admission.revealTimer = this.setTimer(
      () => this.beginAdmission(admission),
      Math.max(0, revealAt - this.now()),
    );
    this.promoteCapacityQueue();
  }

  private beginAdmission(admission: PendingAdmission): void {
    if (!this.admissions.has(admission.id)) {
      return;
    }
    const disconnected = admission.players.find(
      (queued) =>
        !queued.session.socket ||
        queued.session.socket.readyState !== queued.session.socket.OPEN,
    );
    if (disconnected) {
      this.cancelAdmission(admission, disconnected.session.userId);
      return;
    }
    for (const queued of admission.players) {
      this.send(queued.session, {
        type: "match.admission",
        gateEndsAt: admission.gateEndsAt,
      });
    }
    admission.gateTimer = this.setTimer(
      () => this.finishAdmission(admission),
      Math.max(0, admission.gateEndsAt - this.now()),
    );
  }

  private finishAdmission(admission: PendingAdmission): void {
    if (!this.admissions.delete(admission.id)) {
      return;
    }
    const disconnected = admission.players.find(
      (queued) =>
        !queued.session.socket ||
        queued.session.socket.readyState !== queued.session.socket.OPEN,
    );
    if (disconnected) {
      for (const survivor of admission.players) {
        if (
          survivor !== disconnected &&
          survivor.session.socket &&
          survivor.session.socket.readyState === survivor.session.socket.OPEN
        ) {
          this.startSearching(survivor);
        }
      }
      this.promoteCapacityQueue();
      return;
    }
    this.startRoom(admission.players, admission.opponentType);
    this.promoteCapacityQueue();
  }

  private cancelAdmission(
    admission: PendingAdmission,
    leavingUserId: string,
  ): void {
    if (!this.admissions.delete(admission.id)) {
      return;
    }
    if (admission.revealTimer) {
      this.clearTimer(admission.revealTimer);
    }
    if (admission.gateTimer) {
      this.clearTimer(admission.gateTimer);
    }
    for (const queued of admission.players) {
      if (
        queued.session.userId !== leavingUserId &&
        queued.session.socket &&
        queued.session.socket.readyState === queued.session.socket.OPEN
      ) {
        this.startSearching(queued);
      }
    }
    this.promoteCapacityQueue();
  }

  private removeSearching(queued: QueuedPlayer): void {
    const index = this.searching.indexOf(queued);
    if (index >= 0) {
      this.searching.splice(index, 1);
    }
    if (queued.searchTimer) {
      this.clearTimer(queued.searchTimer);
      queued.searchTimer = undefined;
    }
  }

  private startRoom(
    queuedPlayers: QueuedPlayer[],
    opponentType: "human" | "ai",
  ): Room {
    const createdAt = this.now();
    const room: Room = {
      id: randomUUID(),
      status: "active",
      opponentType,
      participants: queuedPlayers.map(({ session, joinedAt }) => ({
        session,
        joinedQueueAt: joinedAt,
        guess: null,
        messageCount: 0,
        connected: true,
        typingActive: false,
      })),
      createdAt,
      expiresAt: createdAt + ROOM_DURATION_MS,
      messages: [],
      timelineSequence: 0,
      hadDisconnect: false,
      aiReplyCount: 0,
    };
    this.rooms.set(room.id, room);
    const initialization = this.initializeRoom(room);
    if (initialization) {
      room.persistenceChain = initialization.catch((error) => {
        room.persistenceFailed = true;
        this.onPersistenceError?.(error, "initialize_room");
      });
      void initialization
        .then(() => this.activateRoom(room))
        .catch(() => {
          room.status = "settled";
          for (const participant of room.participants) {
            this.send(participant.session, {
              type: "game.error",
              code: "ROOM_PERSISTENCE_FAILED",
              message: "对局初始化失败，请重新匹配。",
            });
          }
          this.promoteCapacityQueue();
        });
      return room;
    }
    this.activateRoom(room);
    return room;
  }

  private activateRoom(room: Room): void {
    this.persistTimelineEvent(room, {
      eventType: "room_started",
      occurredAt: room.createdAt,
    });
    for (const participant of room.participants) {
      participant.session.roomId = room.id;
      this.send(participant.session, {
        type: "match.found",
        gameId: room.id,
        startedAt: room.createdAt,
        endsAt: room.expiresAt,
        minGuessAt: room.createdAt + GUESS_UNLOCK_MS,
        opponentLabel: `匿名玩家 / ${room.id.slice(0, 2).toUpperCase()}`,
      });
    }
    this.recordMatch(room.opponentType);
    if (room.opponentType === "human") {
      void this.aiBudget?.recordHumanGame().catch((error) => {
        this.onPersistenceError?.(error, "record_human_ai_budget");
      });
    }
    room.expiryTimer = this.setTimer(
      () => this.settle(room, "timeout"),
      ROOM_DURATION_MS,
    );
  }

  private initializeRoom(room: Room): Promise<void> | null {
    if (!this.gameRepository && !this.roomStore) {
      return null;
    }
    return (async () => {
      if (this.gameRepository) {
        await this.gameRepository.createGame({
          id: room.id,
          status: "active",
          matchType: room.opponentType,
          rulesetVersion: "alpha-2026-07-24.2",
          aiModel:
            room.opponentType === "ai" ? "deepseek-v4-flash" : null,
          aiProfileVersion:
            room.opponentType === "ai" ? "alpha-chat-v1" : null,
          startedAt: new Date(room.createdAt),
          endsAt: new Date(room.expiresAt),
        });
        for (const [seat, participant] of room.participants.entries()) {
          if (!participant.session.databaseUserId) {
            throw new Error("真人参与者缺少数据库用户标识。");
          }
          const row = await this.gameRepository.addParticipant({
            gameId: room.id,
            userId: participant.session.databaseUserId,
            identityType: "human",
            seat,
            joinedQueueAt: new Date(participant.joinedQueueAt),
          });
          participant.databaseParticipantId = row.id;
        }
        if (room.opponentType === "ai") {
          const aiParticipant = await this.gameRepository.addParticipant({
            gameId: room.id,
            userId: null,
            identityType: "ai",
            seat: 1,
            joinedQueueAt: new Date(room.createdAt),
          });
          room.aiDatabaseParticipantId = aiParticipant.id;
        }
      }
      if (this.roomStore) {
        await this.roomStore.saveSnapshot({
          roomId: room.id,
          status: room.status,
          participantIds: room.participants.map(
            (participant) => participant.session.userId,
          ),
          opponentType: room.opponentType,
          createdAt: room.createdAt,
          expiresAt: room.expiresAt,
        });
      }
    })();
  }

  private persistMessage(room: Room, message: ChatMessage): void {
    if (!this.gameRepository && !this.roomStore) return;
    this.enqueuePersistence(room, "append_message", async () => {
      if (this.gameRepository) {
        const participant =
          message.senderId === "ai"
            ? undefined
            : this.participantFor(room, message.senderId);
        await this.gameRepository.appendMessage({
          id: message.id,
          gameId: room.id,
          senderParticipantId:
            message.senderId === "ai"
              ? room.aiDatabaseParticipantId
              : participant?.databaseParticipantId,
          senderType: message.senderId === "ai" ? "ai" : "human",
          content: message.text,
          clientMessageId: message.clientMessageId,
          serverSequence: message.sequence,
          moderated: message.moderated ?? false,
          createdAt: new Date(message.at),
        });
      }
      if (this.roomStore) {
        const stored = await this.roomStore.appendMessage(room.id, {
          id: message.id,
          senderId: message.senderId,
          text: message.text,
          at: message.at,
          metadata: {
            moderated: message.moderated ?? false,
            clientMessageId: message.clientMessageId,
          },
        });
        if (stored.sequence !== message.sequence) {
          throw new Error("房间消息序号与持久化序号不一致。");
        }
      }
    });
  }

  private persistTimelineEvent(
    room: Room,
    input: {
      eventType:
        | "room_started"
        | "typing_start"
        | "typing_stop"
        | "message_received"
        | "message_visible";
      actorParticipantId?: string;
      messageId?: string;
      occurredAt: number;
      moderated?: boolean;
    },
  ): void {
    if (!this.echoArchiveService) return;
    room.timelineSequence += 1;
    const sequence = room.timelineSequence;
    const criticalBarrier = room.persistenceChain ?? Promise.resolve();
    const previousEcho = room.echoPersistenceChain ?? Promise.resolve();
    const next = Promise.all([criticalBarrier, previousEcho]).then(
      async () => {
        await this.echoArchiveService?.appendTimelineEvent({
          gameId: room.id,
          sequence,
          ...input,
        });
      },
    );
    room.echoPersistenceChain = next.catch((error) => {
      room.echoPersistenceFailed = true;
      this.onPersistenceError?.(error, "append_timeline_event");
    });
  }

  private stopParticipantTyping(
    room: Room,
    participant: Participant,
  ): void {
    if (participant.typingExpiry) {
      this.clearTimer(participant.typingExpiry);
      participant.typingExpiry = undefined;
    }
    if (!participant.typingActive) return;
    participant.typingActive = false;
    const occurredAt = this.now();
    this.persistTimelineEvent(room, {
      eventType: "typing_stop",
      actorParticipantId: participant.databaseParticipantId,
      occurredAt,
    });
    this.broadcastToOthers(
      room,
      participant.session.userId,
      { type: "chat.typing_stop" },
    );
  }

  private persistGuess(room: Room, participant: Participant): void {
    if (!this.gameRepository || !participant.guess) return;
    this.enqueuePersistence(room, "submit_guess", async () => {
      if (!participant.databaseParticipantId) {
        throw new Error("参与者缺少数据库标识，无法保存判断。");
      }
      await this.gameRepository?.submitGuess({
        gameId: room.id,
        participantId: participant.databaseParticipantId,
        targetGuess: participant.guess as Guess,
        submittedAt: new Date(this.now()),
      });
    });
  }

  private enqueuePersistence(
    room: Room,
    operation: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const next = (room.persistenceChain ?? Promise.resolve()).then(task);
    room.persistenceChain = next.catch((error) => {
      room.persistenceFailed = true;
      this.onPersistenceError?.(error, operation);
    });
    return next;
  }

  private scheduleAiReply(room: Room): void {
    if (room.aiReplyCount >= 10) {
      return;
    }
    this.cancelAi(room);
    room.aiReplyCount += 1;
    room.aiAbort = new AbortController();
    const controller = room.aiAbort;
    room.aiDelayTimer = this.setTimer(async () => {
      if (room.status !== "active" || controller.signal.aborted) {
        return;
      }
      const participant = room.participants[0];
      if (participant) {
        this.persistTimelineEvent(room, {
          eventType: "typing_start",
          actorParticipantId: room.aiDatabaseParticipantId,
          occurredAt: this.now(),
        });
        this.send(participant.session, {
          type: "chat.typing_start",
          status: "正在组织语言…",
        });
      }
      const reservationId = randomUUID();
      let usageReserved = false;
      let usageOutcome: AiSettlementOutcome = "failed";
      let completionTokens = 0;
      try {
        if (this.aiUsageBudget) {
          const decision = await this.aiUsageBudget.reserve({
            reservationId,
            identity: {
              roomId: room.id,
              userId: participant?.session.userId ?? `room:${room.id}`,
              deviceId:
                participant?.session.deviceId ?? `room:${room.id}:device`,
              ip: participant?.session.ipHash ?? `room:${room.id}:ip`,
            },
            estimatedTokens: AI_USAGE_ESTIMATED_TOKENS,
            now: this.now(),
          } satisfies AiReserveRequest);
          if (!decision.allowed) {
            throw new AppError(
              "AI_USAGE_LIMIT",
              "AI 当前达到使用上限，请稍后重试。",
              429,
            );
          }
          usageReserved = true;
        }
        if (room.status !== "active" || controller.signal.aborted) {
          usageOutcome = "cancelled";
          return;
        }
        const rawReply = await this.aiReply({
          messages: room.messages,
          signal: controller.signal,
        });
        const receivedAt = this.now();
        if (room.status !== "active" || controller.signal.aborted) {
          usageOutcome = "cancelled";
          return;
        }
        completionTokens = Math.min(
          AI_USAGE_MAX_COMPLETION_TOKENS,
          Math.max(1, [...rawReply].length * 2),
        );
        usageOutcome = "success";
        const moderation = this.moderation.evaluate({
          text: rawReply,
          surface: "AI_OUTPUT",
          audit: { actorId: "deepseek-v4-flash" },
        });
        const safeReply =
          moderation.action === "ALLOW" ||
          moderation.action === "REDACT"
            ? moderation.text
            : moderateAiOutput(rawReply);
        const visibleAt = this.now();
        const message: ChatMessage = {
          id: randomUUID(),
          senderId: "ai",
          sender: "opponent",
          text: safeReply,
          at: visibleAt,
          sequence: room.messages.length + 1,
          moderated: moderation.action !== "ALLOW",
        };
        room.messages.push(message);
        this.persistMessage(room, message);
        this.persistTimelineEvent(room, {
          eventType: "message_received",
          actorParticipantId: room.aiDatabaseParticipantId,
          messageId: message.id,
          occurredAt: receivedAt,
          moderated: moderation.action !== "ALLOW",
        });
        this.persistTimelineEvent(room, {
          eventType: "message_visible",
          actorParticipantId: room.aiDatabaseParticipantId,
          messageId: message.id,
          occurredAt: visibleAt,
          moderated: moderation.action !== "ALLOW",
        });
        this.broadcastMessage(room, message, false);
      } catch (error) {
        usageOutcome =
          controller.signal.aborted || room.status !== "active"
            ? "cancelled"
            : "failed";
        if (!controller.signal.aborted && room.status === "active") {
          const current = room.participants[0];
          if (current) {
            this.send(current.session, {
              type: "game.error",
              code: "AI_UNAVAILABLE",
              message: "对方暂时没有回应，你可以继续等待或提交判断。",
            });
          }
        }
      } finally {
        if (usageReserved && this.aiUsageBudget) {
          const conservativeTokens =
            usageOutcome === "success"
              ? {
                  promptTokens: AI_USAGE_ESTIMATED_PROMPT_TOKENS,
                  completionTokens,
                }
              : {
                  promptTokens: AI_USAGE_ESTIMATED_TOKENS,
                  completionTokens: 0,
                };
          try {
            await this.aiUsageBudget.settle({
              reservationId,
              outcome: usageOutcome,
              ...conservativeTokens,
              now: this.now(),
            } satisfies AiSettleRequest);
          } catch (error) {
            this.onPersistenceError?.(error, "settle_ai_usage_budget");
          }
        }
        if (room.status === "active") {
          const current = room.participants[0];
          if (current) {
            this.persistTimelineEvent(room, {
              eventType: "typing_stop",
              actorParticipantId: room.aiDatabaseParticipantId,
              occurredAt: this.now(),
            });
            this.send(current.session, {
              type: "chat.typing_stop",
            });
          }
        }
      }
    }, 500 + Math.floor(this.random() * 1_000));
  }

  private cancelAi(room: Room): void {
    if (room.aiDelayTimer) {
      this.clearTimer(room.aiDelayTimer);
      room.aiDelayTimer = undefined;
    }
    room.aiAbort?.abort();
    room.aiAbort = undefined;
  }

  private settle(
    room: Room,
    reason: SettlementView["reason"],
  ): Array<{ userId: string; view: SettlementView }> {
    if (room.status === "settled") {
      return [];
    }
    room.status = "settled";
    this.promoteCapacityQueue();
    this.cancelAi(room);
    for (const participant of room.participants) {
      this.stopParticipantTyping(room, participant);
    }
    if (room.expiryTimer) {
      this.clearTimer(room.expiryTimer);
      room.expiryTimer = undefined;
    }
    const results = room.participants.map((participant) => {
      const opponentType: "human" | "ai" =
        room.opponentType === "ai" ? "ai" : "human";
      const view: SettlementView = {
        roomId: room.id,
        reason,
        opponentType,
        yourGuess: participant.guess,
        correct:
          participant.guess === null
            ? null
            : participant.guess === opponentType,
        durationMs: Math.max(0, this.now() - room.createdAt),
      };
      return {
        userId: participant.session.userId,
        participant,
        view,
      };
    });
    if (this.gameRepository) {
      void this.enqueuePersistence(room, "settle_game", async () => {
        if (room.persistenceFailed) {
          throw new Error("此前持久化操作失败，禁止发布结算结果。");
        }
        await this.gameRepository?.settleGame({
          gameId: room.id,
          reason,
          settledAt: new Date(this.now()),
          participants: results.map(({ participant, view }) => {
            if (!participant.databaseParticipantId) {
              throw new Error("参与者缺少数据库标识，无法结算。");
            }
            return {
              settlementId: randomUUID(),
              participantId: participant.databaseParticipantId,
              userId: participant.session.databaseUserId,
              opponentType: view.opponentType,
              playerGuess: view.yourGuess,
              correct: view.correct,
              outcome:
                view.correct === null
                  ? "draw"
                  : view.correct
                    ? "won"
                    : "lost",
              scoreDelta: view.correct ? 10 : 0,
              durationMs: view.durationMs,
            };
          }),
        });
      })
        .then(async () => {
          await room.echoPersistenceChain;
          let archiveConsentEligible = false;
          try {
            archiveConsentEligible =
              (await this.echoArchiveService?.initializeArchiveCandidate({
                gameId: room.id,
                durationMs: results[0]?.view.durationMs ?? 0,
                eligible:
                  reason !== "disconnect" &&
                  this.isArchiveConversationEligible(room) &&
                  room.persistenceFailed !== true &&
                  room.echoPersistenceFailed !== true,
                now: this.now(),
              })) ?? false;
          } catch (error) {
            this.onPersistenceError?.(
              error,
              "initialize_echo_archive_candidate",
            );
          }
          this.publishSettlement(results, archiveConsentEligible);
        })
        .catch(() => {
          for (const { participant } of results) {
            this.send(participant.session, {
              type: "game.error",
              code: "SETTLEMENT_PERSISTENCE_FAILED",
              message: "结算暂时失败，结果尚未计入，请稍后重试。",
            });
          }
        });
    } else {
      this.publishSettlement(results, false);
    }
    if (this.roomStore) {
      void this.roomStore
        .saveSnapshot({
          roomId: room.id,
          status: room.status,
          participantIds: room.participants.map(
            (participant) => participant.session.userId,
          ),
          opponentType: room.opponentType,
          createdAt: room.createdAt,
          expiresAt: room.expiresAt,
          lastSequence: room.messages.at(-1)?.sequence ?? 0,
        })
        .catch((error) => {
          this.onPersistenceError?.(error, "settle_room_snapshot");
        });
    }
    return results.map(({ userId, view }) => ({ userId, view }));
  }

  private publishSettlement(
    results: Array<{
      participant: Participant;
      view: SettlementView;
    }>,
    archiveConsentEligible: boolean,
  ): void {
    for (const { participant, view } of results) {
      this.send(participant.session, {
        type: "game.finished",
        opponentType: view.opponentType,
        guess: view.yourGuess,
        isCorrect: view.correct === true,
        outcome:
          view.correct === null ? "draw" : view.correct ? "won" : "lost",
        archiveConsentEligible,
        stats: {
          durationSeconds: Math.round(view.durationMs / 1_000),
          messageCount: participant.messageCount,
          streak: view.correct ? 1 : 0,
          scoreDelta: view.correct ? 10 : 0,
        },
      });
    }
  }

  private isArchiveConversationEligible(room: Room): boolean {
    if (room.hadDisconnect || room.messages.length < 4) return false;
    const actors =
      room.opponentType === "ai"
        ? [room.participants[0]?.session.userId, "ai"]
        : room.participants.map(
            (participant) => participant.session.userId,
          );
    return (
      actors.length === 2 &&
      actors.every(
        (actor) =>
          typeof actor === "string" &&
          room.messages.some((message) => message.senderId === actor),
      )
    );
  }

  private participantFor(room: Room, userId: string): Participant {
    const participant = room.participants.find(
      (candidate) => candidate.session.userId === userId,
    );
    if (!participant) {
      throw new AppError(
        "ROOM_FORBIDDEN",
        "你无权访问这个对局。",
        403,
      );
    }
    return participant;
  }

  private requireAuthorizedRoom(session: Session): Room {
    const room = this.requireOwnedRoom(session);
    if (room.status !== "active") {
      throw new AppError("ROOM_ENDED", "本局已经结束。");
    }
    return room;
  }

  private requireOwnedRoom(session: Session): Room {
    if (!session.roomId) {
      throw new AppError("ROOM_NOT_FOUND", "当前没有可用对局。", 404);
    }
    const room = this.rooms.get(session.roomId);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "对局不存在。", 404);
    }
    this.participantFor(room, session.userId);
    return room;
  }

  private broadcastMessage(
    room: Room,
    message: ChatMessage,
    replaced: boolean,
  ): void {
    for (const participant of room.participants) {
      this.sendChatMessage(
        participant.session,
        message,
        replaced && message.senderId === participant.session.userId,
      );
    }
  }

  private sendChatMessage(
    session: Session,
    message: ChatMessage,
    moderated: boolean,
  ): void {
    const view = this.messageFor(message, session.userId);
    this.send(session, {
      type: "chat.message",
      id: view.id,
      sender: view.sender,
      content: view.text,
      sequence: view.sequence,
      createdAt: view.at,
      moderated,
    });
  }

  private messageFor(message: ChatMessage, userId: string): ChatMessage {
    return {
      ...message,
      sender: message.senderId === userId ? "self" : "opponent",
    };
  }

  private broadcastToOthers(
    room: Room,
    userId: string,
    envelope: WsEnvelope,
  ): void {
    for (const participant of room.participants) {
      if (participant.session.userId !== userId) {
        this.send(participant.session, envelope);
      }
    }
  }

  private send(session: Session, envelope: WsEnvelope): void {
    const socket = session.socket;
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(envelope));
    }
  }

  private recordMatch(type: "human" | "ai"): void {
    this.recentMatchTypes.push(type);
    if (this.recentMatchTypes.length > 100) {
      this.recentMatchTypes.shift();
    }
    this.onMetric?.(this.getMetrics());
  }
}
