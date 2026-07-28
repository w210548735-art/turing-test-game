export type Screen =
  | "onboarding"
  | "queue"
  | "matching"
  | "admission"
  | "chat"
  | "finished";
export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";
export type Sender = "self" | "opponent" | "system";
export type GuessTarget = "human" | "ai";

export interface ChatMessage {
  id: string;
  sender: Sender;
  content: string;
  sequence: number;
  createdAt: number;
}

export interface GameResult {
  opponentType: GuessTarget;
  guess: GuessTarget | null;
  isCorrect: boolean;
  outcome: "won" | "lost" | "draw" | string;
  stats?: {
    durationSeconds?: number;
    messageCount?: number;
    streak?: number;
    scoreDelta?: number;
  };
}

export interface GameState {
  screen: Screen;
  connection: ConnectionState;
  nickname: string;
  thinkingStatus: string;
  demoMode: boolean;
  queuePosition: number | null;
  queuedAt: number | null;
  searchStartedAt: number | null;
  gateEndsAt: number | null;
  matchProgress: number;
  gameId: string | null;
  startedAt: number | null;
  endsAt: number | null;
  minGuessAt: number | null;
  opponentLabel: string;
  messages: ChatMessage[];
  opponentTyping: boolean;
  opponentTypingStatus: string;
  guessSubmitted: GuessTarget | null;
  result: GameResult | null;
  error: string | null;
  notice: string | null;
  reportConfirmed: boolean;
}

export const initialState: GameState = {
  screen: "onboarding",
  connection: "idle",
  nickname: "",
  thinkingStatus: "正在斟酌词句…",
  demoMode: false,
  queuePosition: null,
  queuedAt: null,
  searchStartedAt: null,
  gateEndsAt: null,
  matchProgress: 0,
  gameId: null,
  startedAt: null,
  endsAt: null,
  minGuessAt: null,
  opponentLabel: "匿名玩家",
  messages: [],
  opponentTyping: false,
  opponentTypingStatus: "对方正在输入…",
  guessSubmitted: null,
  result: null,
  error: null,
  notice: null,
  reportConfirmed: false,
};

export type GameAction =
  | {
      type: "PROFILE_SAVED";
      nickname: string;
      thinkingStatus: string;
      demoMode: boolean;
    }
  | { type: "CONNECTION"; connection: ConnectionState }
  | { type: "MATCH_QUEUED"; position: number; queuedAt: number }
  | { type: "MATCH_SEARCHING"; searchStartedAt: number }
  | { type: "MATCH_ADMISSION"; gateEndsAt: number }
  | { type: "MATCH_PROGRESS"; progress: number }
  | {
      type: "MATCH_FOUND";
      gameId: string;
      startedAt: number;
      endsAt: number;
      minGuessAt: number;
      opponentLabel: string;
    }
  | { type: "MESSAGE_RECEIVED"; message: ChatMessage }
  | { type: "OPPONENT_TYPING"; value: boolean; status?: string }
  | { type: "GUESS_ACCEPTED"; guess: GuessTarget }
  | { type: "GAME_FINISHED"; result: GameResult }
  | { type: "ERROR"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "NOTICE"; message: string | null }
  | { type: "REPORT_CONFIRMED" }
  | { type: "RESET_GAME" }
  | { type: "RESET_ALL" };

export function gameReducer(
  state: GameState,
  action: GameAction,
): GameState {
  switch (action.type) {
    case "PROFILE_SAVED":
      return {
        ...state,
        screen: "matching",
        nickname: action.nickname,
        thinkingStatus: action.thinkingStatus,
        demoMode: action.demoMode,
        error: null,
      };
    case "CONNECTION":
      return { ...state, connection: action.connection };
    case "MATCH_QUEUED":
      return {
        ...state,
        screen: "queue",
        queuePosition: action.position,
        queuedAt: action.queuedAt,
        searchStartedAt: null,
        gateEndsAt: null,
        matchProgress: 0,
      };
    case "MATCH_SEARCHING":
      return {
        ...state,
        screen: "matching",
        queuePosition: null,
        queuedAt: null,
        searchStartedAt: action.searchStartedAt,
        gateEndsAt: null,
        matchProgress: 0,
      };
    case "MATCH_ADMISSION":
      return {
        ...state,
        screen: "admission",
        queuePosition: null,
        queuedAt: null,
        searchStartedAt: null,
        gateEndsAt: action.gateEndsAt,
        matchProgress: 0,
      };
    case "MATCH_PROGRESS":
      return {
        ...state,
        matchProgress: Math.min(1, Math.max(0, action.progress)),
      };
    case "MATCH_FOUND":
      return {
        ...state,
        screen: "chat",
        gameId: action.gameId,
        startedAt: action.startedAt,
        endsAt: action.endsAt,
        minGuessAt: action.minGuessAt,
        opponentLabel: action.opponentLabel,
        queuePosition: null,
        queuedAt: null,
        searchStartedAt: null,
        gateEndsAt: null,
        matchProgress: 1,
        error: null,
      };
    case "MESSAGE_RECEIVED": {
      if (state.messages.some((message) => message.id === action.message.id)) {
        return state;
      }
      return {
        ...state,
        messages: [...state.messages, action.message].sort(
          (left, right) => left.sequence - right.sequence,
        ),
      };
    }
    case "OPPONENT_TYPING":
      return {
        ...state,
        opponentTyping: action.value,
        opponentTypingStatus:
          action.status?.trim() || state.opponentTypingStatus,
      };
    case "GUESS_ACCEPTED":
      return {
        ...state,
        guessSubmitted: action.guess,
        notice: "判断已锁定，但对话仍然开放；身份将在本局结束后揭晓。",
      };
    case "GAME_FINISHED":
      return {
        ...state,
        screen: "finished",
        opponentTyping: false,
        result: action.result,
        notice: null,
      };
    case "ERROR":
      return { ...state, error: action.message };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "NOTICE":
      return { ...state, notice: action.message };
    case "REPORT_CONFIRMED":
      return {
        ...state,
        reportConfirmed: true,
        notice: "举报已记录，我们会复核本局内容。",
      };
    case "RESET_GAME":
      return {
        ...initialState,
        screen: "matching",
        connection: state.connection,
        nickname: state.nickname,
        thinkingStatus: state.thinkingStatus,
        demoMode: state.demoMode,
      };
    case "RESET_ALL":
      return initialState;
    default:
      return state;
  }
}

export function canSubmitGuess(
  state: Pick<GameState, "minGuessAt" | "guessSubmitted" | "screen">,
  now: number,
): boolean {
  return (
    state.screen === "chat" &&
    state.minGuessAt !== null &&
    now >= state.minGuessAt &&
    state.guessSubmitted === null
  );
}
