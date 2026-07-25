import type { WebSocket } from "ws";

export type Identity = "human" | "ai";
export type Guess = Identity;
export type RoomStatus = "active" | "settled";

export interface Profile {
  nickname: string;
  typingStatus: string;
}

export interface Session {
  sessionId: string;
  tokenHash: string;
  userId: string;
  ipHash: string;
  deviceId: string;
  csrfHash: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  expiresAt: number;
  databaseUserId?: string;
  accountAuthenticated?: boolean;
  profile: Profile;
  socket?: WebSocket;
  roomId?: string;
}

export interface ChatMessage {
  id: string;
  senderId: string | "ai";
  sender: "self" | "opponent";
  text: string;
  at: number;
  sequence: number;
  clientMessageId?: string;
  moderated?: boolean;
}

export interface Participant {
  session: Session;
  databaseParticipantId?: string;
  joinedQueueAt: number;
  guess: Guess | null;
  guessClientId?: string;
  messageCount: number;
  connected: boolean;
  disconnectTimer?: NodeJS.Timeout;
  typingActive: boolean;
  typingExpiry?: NodeJS.Timeout;
}

export interface Room {
  id: string;
  status: RoomStatus;
  opponentType: Identity;
  participants: Participant[];
  createdAt: number;
  expiresAt: number;
  messages: ChatMessage[];
  timelineSequence: number;
  hadDisconnect: boolean;
  aiAbort?: AbortController;
  aiDelayTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  aiReplyCount: number;
  aiTemporaryName?: string;
  aiDatabaseParticipantId?: string;
  persistenceChain?: Promise<void>;
  persistenceFailed?: boolean;
  echoPersistenceChain?: Promise<void>;
  echoPersistenceFailed?: boolean;
}

export interface SettlementView {
  roomId: string;
  reason: "all_guessed" | "player_guessed" | "timeout" | "disconnect";
  opponentType: Identity;
  yourGuess: Guess | null;
  correct: boolean | null;
  durationMs: number;
}

export interface ReportRecord {
  id: string;
  reporterId: string;
  roomId: string;
  reportedUserId: string;
  reportedParticipantId?: string;
  reason: string;
  createdAt: number;
  evidence: {
    opponentType: Identity;
    messages: ChatMessage[];
  };
}

export interface WsEnvelope {
  type: string;
  requestId?: string;
  payload?: unknown;
  [key: string]: unknown;
}
