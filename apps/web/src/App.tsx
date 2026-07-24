import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  canSubmitGuess,
  gameReducer,
  initialState,
  type ChatMessage,
  type GameResult,
  type GuessTarget,
} from "./game-machine";
import {
  hitRate,
  localRecordKey,
  readLocalRecord,
  recordFinishedGame,
  type LocalPlayerRecord,
  writeLocalRecord,
} from "./local-record";
import { pickOpeningQuestions } from "./opening-questions";
import {
  bootstrapAccount,
  DemoTransport,
  forgotAccountPassword,
  loginAccount,
  logoutAccount,
  type AccountSessionResponse,
  type GameTransport,
  OnlineTransport,
  registerAccount,
  resetAccountPassword,
  saveProfile,
  submitAccountFeedback,
  type ServerEvent,
  type FeedbackCategory,
  verifyAccountEmail,
} from "./transport";

const THINKING_SUGGESTIONS = [
  "正在斟酌词句…",
  "正在验证假设…",
  "正在努力像个人类…",
];

const MATCH_SEARCH_MESSAGES = [
  "正在为你寻找一位旗鼓相当的对手",
  "正在扫描此刻在线的匿名玩家",
  "好的对话，值得多等一会儿",
  "正在把两位观察者带到同一扇门前",
];

const BILIBILI_SPACE_URL =
  "https://space.bilibili.com/485008770?spm_id_from=333.1007.0.0";
const DOUYIN_SPACE_URL = "https://v.douyin.com/l_xBqIYez08/";

type AuthMode = "login" | "register" | "forgot" | "reset" | "verify";

interface InitialAuthRoute {
  mode: AuthMode;
  token: string | null;
}

function getInitialAuthRoute(): InitialAuthRoute {
  const path = window.location.pathname.replace(/\/+$/, "");
  const token = new URLSearchParams(window.location.search).get("token");
  if (path.endsWith("/verify-email")) {
    return { mode: "verify", token };
  }
  if (path.endsWith("/reset-password")) {
    return { mode: "reset", token };
  }
  return { mode: "login", token: null };
}

function clearAuthRoute(): void {
  window.history.replaceState({}, "", "/");
}

function timestamp(value: string | number): number {
  if (typeof value === "number") {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

function createMessageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `message-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [onClose]);
}

export default function App() {
  const [initialAuthRoute] = useState(getInitialAuthRoute);
  const [authToken, setAuthToken] = useState(initialAuthRoute.token);
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthRoute.mode);
  const [accountSession, setAccountSession] =
    useState<AccountSessionResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [localDemoBypass, setLocalDemoBypass] = useState(false);
  const [state, dispatch] = useReducer(gameReducer, initialState);
  const [now, setNow] = useState(Date.now());
  const [nickname, setNickname] = useState("");
  const [thinkingStatus, setThinkingStatus] = useState(
    THINKING_SUGGESTIONS[0],
  );
  const [messageDraft, setMessageDraft] = useState("");
  const [guessOpen, setGuessOpen] = useState(false);
  const [guessTarget, setGuessTarget] = useState<GuessTarget>("human");
  const [confidence, setConfidence] = useState(68);
  const [reportOpen, setReportOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const openingQuestions = useMemo(
    () => pickOpeningQuestions(3),
    [state.gameId],
  );
  const [isStarting, setIsStarting] = useState(false);
  const [pendingGuess, setPendingGuess] = useState<GuessTarget | null>(null);
  const recordKey = localRecordKey(accountSession?.user.id);
  const [localRecord, setLocalRecord] = useState<LocalPlayerRecord>(() =>
    readLocalRecord(localRecordKey()),
  );

  const transportRef = useRef<GameTransport | null>(null);
  const stateRef = useRef(state);
  const pendingGuessRef = useRef<GuessTarget | null>(null);
  const gateEndRef = useRef<number | null>(null);
  const delayedMatchTimerRef = useRef<number | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const hasSentTypingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;

    async function restoreAccount() {
      if (initialAuthRoute.mode === "reset") {
        if (!initialAuthRoute.token) {
          setAuthError("重置链接缺少 Token，请重新申请密码重置邮件。");
        }
        setAuthLoading(false);
        return;
      }

      if (initialAuthRoute.mode === "verify") {
        if (!initialAuthRoute.token) {
          setAuthError("验证链接缺少 Token，请重新注册或申请验证邮件。");
          setAuthLoading(false);
          return;
        }
        try {
          const result = await verifyAccountEmail({
            token: initialAuthRoute.token,
          });
          if (active && result.verified) {
            clearAuthRoute();
            setAuthToken(null);
            setAuthMode("login");
            setAuthMessage("邮箱验证成功，现在可以登录。");
          }
        } catch (error) {
          if (active) {
            setAuthError(
              error instanceof Error ? error.message : "邮箱验证失败。",
            );
          }
        } finally {
          if (active) {
            setAuthLoading(false);
          }
        }
        return;
      }

      try {
        const session = await bootstrapAccount();
        if (active) {
          setAccountSession(session);
        }
      } catch (error) {
        if (active) {
          setAuthError(
            error instanceof Error ? error.message : "无法恢复账户会话。",
          );
        }
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    }

    void restoreAccount();
    return () => {
      active = false;
    };
  }, [initialAuthRoute]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    setLocalRecord(readLocalRecord(recordKey));
  }, [recordKey]);

  useEffect(() => {
    if (
      state.screen !== "finished" ||
      !state.gameId ||
      !state.result
    ) {
      return;
    }
    setLocalRecord((current) => {
      const next = recordFinishedGame(current, state.gameId!, state.result!);
      if (next !== current) writeLocalRecord(recordKey, next);
      return next;
    });
  }, [recordKey, state.gameId, state.result, state.screen]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages, state.opponentTyping]);

  useEffect(
    () => () => {
      transportRef.current?.close();
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
      }
      if (delayedMatchTimerRef.current !== null) {
        window.clearTimeout(delayedMatchTimerRef.current);
      }
    },
    [],
  );

  const sendSafely = useCallback(
    (event: Parameters<GameTransport["send"]>[0]) => {
      try {
        transportRef.current?.send(event);
      } catch (error) {
        dispatch({
          type: "ERROR",
          message:
            error instanceof Error ? error.message : "操作未能发送，请重试。",
        });
      }
    },
    [],
  );

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "match.queued":
          gateEndRef.current = null;
          dispatch({
            type: "MATCH_QUEUED",
            position: event.position,
            queuedAt: timestamp(event.queuedAt),
          });
          break;
        case "match.searching":
          gateEndRef.current = null;
          dispatch({
            type: "MATCH_SEARCHING",
            searchStartedAt: timestamp(event.searchStartedAt),
          });
          break;
        case "match.admission":
          gateEndRef.current = timestamp(event.gateEndsAt);
          dispatch({
            type: "MATCH_ADMISSION",
            gateEndsAt: gateEndRef.current,
          });
          break;
        case "match.progress":
          dispatch({ type: "MATCH_PROGRESS", progress: event.progress });
          break;
        case "match.found": {
          const releaseAt = Math.max(Date.now(), gateEndRef.current ?? 0);
          const showMatch = () => {
            const visibleStartedAt = Date.now();
            dispatch({
              type: "MATCH_FOUND",
              gameId: event.gameId,
              startedAt: visibleStartedAt,
              endsAt: timestamp(event.endsAt),
              minGuessAt: Math.max(
                timestamp(event.minGuessAt),
                visibleStartedAt + 20_000,
              ),
              opponentLabel: event.opponentLabel || "匿名玩家",
            });
            gateEndRef.current = null;
            delayedMatchTimerRef.current = null;
          };
          const delay = releaseAt - Date.now();
          if (delay > 0) {
            delayedMatchTimerRef.current = window.setTimeout(showMatch, delay);
          } else {
            showMatch();
          }
          break;
        }
        case "chat.message":
          dispatch({
            type: "MESSAGE_RECEIVED",
            message: {
              id: event.id,
              sender: event.sender,
              content: event.content,
              sequence: event.sequence,
              createdAt: timestamp(event.createdAt),
            },
          });
          break;
        case "chat.typing_start":
          dispatch({
            type: "OPPONENT_TYPING",
            value: true,
            status: event.status,
          });
          break;
        case "chat.typing_stop":
          dispatch({ type: "OPPONENT_TYPING", value: false });
          break;
        case "guess.accepted": {
          const acceptedGuess =
            event.targetGuess ??
            pendingGuessRef.current ??
            stateRef.current.guessSubmitted;
          if (acceptedGuess) {
            dispatch({ type: "GUESS_ACCEPTED", guess: acceptedGuess });
          }
          pendingGuessRef.current = null;
          setPendingGuess(null);
          setGuessOpen(false);
          break;
        }
        case "game.finished":
          dispatch({
            type: "GAME_FINISHED",
            result: {
              opponentType: event.opponentType,
              guess: event.guess,
              isCorrect: event.isCorrect,
              outcome: event.outcome,
              stats: event.stats,
            },
          });
          pendingGuessRef.current = null;
          setPendingGuess(null);
          break;
        case "game.error":
          dispatch({
            type: "ERROR",
            message: event.message ?? `服务器错误：${event.code ?? "unknown"}`,
          });
          break;
        case "game.disconnected":
          dispatch({ type: "CONNECTION", connection: "disconnected" });
          dispatch({
            type: "NOTICE",
            message: event.message ?? "对局连接中断，正在尝试恢复。",
          });
          break;
        case "game.reconnected":
          dispatch({ type: "CONNECTION", connection: "connected" });
          dispatch({
            type: "NOTICE",
            message: event.message ?? "连接已恢复。",
          });
          break;
        case "game.reported":
          dispatch({ type: "REPORT_CONFIRMED" });
          setReportOpen(false);
          break;
        case "game.snapshot":
          event.messages.forEach((message) => {
            dispatch({
              type: "MESSAGE_RECEIVED",
              message: {
                ...message,
                createdAt: timestamp(message.createdAt),
              },
            });
          });
          dispatch({
            type: "NOTICE",
            message: "已恢复房间并补齐断线期间的消息。",
          });
          break;
        case "session.ready":
        case "pong":
          break;
      }
    },
    [],
  );

  const changeAuthMode = useCallback((mode: AuthMode) => {
    setAuthMode(mode);
    setAuthError(null);
    setAuthMessage(null);
    if (mode !== "reset" && mode !== "verify") {
      clearAuthRoute();
    }
  }, []);

  const handleLogin = useCallback(
    async (email: string, password: string) => {
      setAuthBusy(true);
      setAuthError(null);
      setAuthMessage(null);
      try {
        const session = await loginAccount({ email, password });
        setAccountSession(session);
        setLocalDemoBypass(false);
        dispatch({ type: "RESET_ALL" });
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "登录失败。");
      } finally {
        setAuthBusy(false);
      }
    },
    [],
  );

  const handleRegister = useCallback(
    async (email: string, password: string) => {
      setAuthBusy(true);
      setAuthError(null);
      setAuthMessage(null);
      try {
        const result = await registerAccount({ email, password });
        setAuthMessage(result.message || "注册请求已受理，请查收验证邮件。");
        setAuthMode("login");
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "注册失败。");
      } finally {
        setAuthBusy(false);
      }
    },
    [],
  );

  const handleForgotPassword = useCallback(async (email: string) => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthMessage(null);
    try {
      const result = await forgotAccountPassword({ email });
      setAuthMessage(
        result.message || "如果账户存在，密码重置邮件将很快送达。",
      );
      setAuthMode("login");
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "无法提交密码重置请求。",
      );
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const handleResetPassword = useCallback(
    async (newPassword: string) => {
      if (!authToken) {
        setAuthError("重置链接缺少 Token，请重新申请密码重置邮件。");
        return;
      }
      setAuthBusy(true);
      setAuthError(null);
      setAuthMessage(null);
      try {
        await resetAccountPassword({
          token: authToken,
          newPassword,
        });
        clearAuthRoute();
        setAuthToken(null);
        setAuthMode("login");
        setAuthMessage("密码已重置，所有旧会话均已撤销，请重新登录。");
      } catch (error) {
        setAuthError(
          error instanceof Error ? error.message : "密码重置失败。",
        );
      } finally {
        setAuthBusy(false);
      }
    },
    [authToken],
  );

  const handleLogout = useCallback(async () => {
    if (!accountSession) {
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      await logoutAccount(accountSession.csrfToken);
      transportRef.current?.close();
      transportRef.current = null;
      setAccountSession(null);
      setLocalDemoBypass(false);
      setNickname("");
      dispatch({ type: "RESET_ALL" });
      setAuthMode("login");
      setAuthMessage("已安全退出当前会话。");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "退出失败。");
    } finally {
      setAuthBusy(false);
    }
  }, [accountSession]);

  async function handleFeedbackSubmit(input: {
    category: FeedbackCategory;
    title: string;
    details: string;
  }): Promise<void> {
    if (!accountSession) {
      setFeedbackError("登录账户后才能把反馈安全送到作者邮箱喵。");
      return;
    }
    setFeedbackBusy(true);
    setFeedbackError(null);
    try {
      const result = await submitAccountFeedback(
        accountSession.csrfToken,
        input,
      );
      setFeedbackMessage(result.message);
    } catch (error) {
      setFeedbackError(
        error instanceof Error ? error.message : "反馈发送失败，请稍后重试。",
      );
    } finally {
      setFeedbackBusy(false);
    }
  }

  const startGame = useCallback(
    async (
      profileNickname: string,
      profileThinkingStatus: string,
      demoMode: boolean,
    ) => {
      setIsStarting(true);
      dispatch({
        type: "PROFILE_SAVED",
        nickname: profileNickname,
        thinkingStatus: profileThinkingStatus,
        demoMode,
      });
      dispatch({ type: "CONNECTION", connection: "connecting" });

      try {
        transportRef.current?.close();
        let transport: GameTransport;
        if (demoMode) {
          transport = new DemoTransport({
            onEvent: handleServerEvent,
            onConnectionChange: (connection) =>
              dispatch({ type: "CONNECTION", connection }),
          });
        } else {
          if (!accountSession) {
            throw new Error("请先登录账户，再进入在线匹配。");
          }
          const initialWsTicket = accountSession.wsTicket;
          if (initialWsTicket) {
            // 一次性票据交给传输层后立即从 React 内存状态中移除。
            setAccountSession((current) =>
              current
                ? {
                    ...current,
                    wsTicket: undefined,
                    wsTicketExpiresAt: undefined,
                  }
                : null,
            );
          }
          await saveProfile(accountSession.csrfToken, {
            nickname: profileNickname,
            typingStatus: profileThinkingStatus,
          });
          transport = new OnlineTransport(
            accountSession.csrfToken,
            {
              onEvent: handleServerEvent,
              onConnectionChange: (connection) =>
                dispatch({ type: "CONNECTION", connection }),
            },
            initialWsTicket,
          );
        }
        transportRef.current = transport;
        await transport.connect();
        transport.send({ type: "match.join" });
      } catch (error) {
        dispatch({ type: "CONNECTION", connection: "disconnected" });
        dispatch({
          type: "ERROR",
          message:
            error instanceof Error
              ? `${error.message} 你可以切换到本地演示继续体验。`
              : "启动失败，你可以切换到本地演示继续体验。",
        });
      } finally {
        setIsStarting(false);
      }
    },
    [accountSession, handleServerEvent],
  );

  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountSession) {
      dispatch({ type: "ERROR", message: "在线匹配需要先登录账户。" });
      return;
    }
    const cleanNickname = nickname.trim();
    const cleanStatus = thinkingStatus.trim();
    if (cleanNickname.length < 2) {
      dispatch({ type: "ERROR", message: "昵称至少需要 2 个字符。" });
      return;
    }
    if (cleanStatus.length < 2) {
      dispatch({ type: "ERROR", message: "请填写你的思考状态。" });
      return;
    }
    void startGame(cleanNickname, cleanStatus, false);
  }

  function startDemo() {
    const cleanNickname = nickname.trim() || state.nickname || "观察者";
    const cleanStatus =
      thinkingStatus.trim() || state.thinkingStatus || "正在验证假设…";
    void startGame(cleanNickname, cleanStatus, true);
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = messageDraft.trim();
    if (!content || state.guessSubmitted) {
      return;
    }
    sendSafely({
      type: "chat.send",
      content,
      clientMessageId: createMessageId(),
    });
    stopTyping();
    setMessageDraft("");
  }

  function updateMessageDraft(value: string) {
    setMessageDraft(value);
    if (!hasSentTypingRef.current && value.trim()) {
      sendSafely({ type: "chat.typing_start" });
      hasSentTypingRef.current = true;
    }
    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = window.setTimeout(stopTyping, 900);
  }

  function stopTyping() {
    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (hasSentTypingRef.current) {
      sendSafely({ type: "chat.typing_stop" });
      hasSentTypingRef.current = false;
    }
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function submitGuess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitGuess(state, Date.now()) || pendingGuess) {
      return;
    }
    setPendingGuess(guessTarget);
    pendingGuessRef.current = guessTarget;
    sendSafely({
      type: "guess.submit",
      targetGuess: guessTarget,
      confidence,
      clientGuessId: createMessageId(),
    });
  }

  function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    sendSafely({
      type: "game.report",
      reason: String(data.get("reason") ?? "other"),
      details: String(data.get("details") ?? "").trim(),
    });
  }

  function playAgain() {
    dispatch({ type: "RESET_GAME" });
    setMessageDraft("");
    setPendingGuess(null);
    pendingGuessRef.current = null;
    setGuessTarget("human");
    setConfidence(68);
    setNow(Date.now());
    sendSafely({ type: "match.join" });
  }

  function cancelMatching() {
    sendSafely({ type: "match.cancel" });
    transportRef.current?.close();
    transportRef.current = null;
    gateEndRef.current = null;
    if (delayedMatchTimerRef.current !== null) {
      window.clearTimeout(delayedMatchTimerRef.current);
      delayedMatchTimerRef.current = null;
    }
    dispatch({ type: "RESET_ALL" });
  }

  function leaveGame() {
    sendSafely({ type: "game.leave" });
    transportRef.current?.close();
    transportRef.current = null;
    setLeaveOpen(false);
    dispatch({ type: "RESET_ALL" });
    setNickname("");
  }

  const gateRemaining = Math.max(0, (state.gateEndsAt ?? now) - now);
  const gateDurationProgress = state.gateEndsAt
    ? Math.min(1, Math.max(0, 1 - gateRemaining / 5_000))
    : state.matchProgress;
  const matchProgress = Math.max(state.matchProgress, gateDurationProgress);
  const queueElapsed = Math.max(0, now - (state.queuedAt ?? now));
  const searchElapsed = Math.max(
    0,
    now - (state.searchStartedAt ?? now),
  );
  const searchMessage =
    MATCH_SEARCH_MESSAGES[
      Math.floor(searchElapsed / 3_000) % MATCH_SEARCH_MESSAGES.length
    ];
  const guessRemaining = Math.max(0, (state.minGuessAt ?? now) - now);
  const gameRemaining = Math.max(0, (state.endsAt ?? now) - now);
  const guessReady = canSubmitGuess(state, now);

  const connectionLabel = useMemo(() => {
    if (state.demoMode) return "LOCAL DEMO";
    if (state.connection === "connected") return "LIVE";
    if (state.connection === "connecting") return "CONNECTING";
    if (state.connection === "disconnected") return "OFFLINE";
    return "STANDBY";
  }, [state.connection, state.demoMode]);

  const showAccountAccess =
    authLoading || (!accountSession && !localDemoBypass);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="图灵测试首页">
          TURING<span>?</span>
        </a>
        <div className="header-index" aria-hidden="true">
          EXP. / 001
        </div>
        <div className="header-actions">
          {!showAccountAccess &&
            (state.screen === "onboarding" || state.screen === "finished") && (
            <button
              className="header-record"
              type="button"
              onClick={() => setRecordOpen(true)}
            >
              <span>账户数据</span>
              <strong>{String(localRecord.rounds).padStart(2, "0")} 局</strong>
              <strong>{hitRate(localRecord)}%</strong>
            </button>
          )}
          {accountSession && (
            <button
              className="header-logout"
              type="button"
              disabled={authBusy}
              onClick={() => void handleLogout()}
            >
              退出
            </button>
          )}
          {!accountSession &&
            localDemoBypass &&
            state.screen === "onboarding" && (
              <button
                className="header-logout"
                type="button"
                onClick={() => setLocalDemoBypass(false)}
              >
                账户登录
              </button>
            )}
          <div className={`connection-pill is-${state.connection}`}>
            <span className="status-dot" />
            {connectionLabel}
          </div>
        </div>
      </header>

      <main>
        {!showAccountAccess && state.error && (
          <div className="error-banner" role="alert">
            <span>{state.error}</span>
            <button type="button" onClick={() => dispatch({ type: "CLEAR_ERROR" })}>
              知道了
            </button>
          </div>
        )}

        {!showAccountAccess && state.notice && (
          <div className="notice-banner" role="status">
            <span>{state.notice}</span>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => dispatch({ type: "NOTICE", message: null })}
            >
              ×
            </button>
          </div>
        )}

        {showAccountAccess && (
          <AccountAccess
            mode={authMode}
            loading={authLoading}
            busy={authBusy}
            error={authError}
            message={authMessage}
            hasResetToken={Boolean(authToken)}
            onModeChange={changeAuthMode}
            onLogin={handleLogin}
            onRegister={handleRegister}
            onForgotPassword={handleForgotPassword}
            onResetPassword={handleResetPassword}
            onLocalDemo={() => {
              setAuthError(null);
              setAuthMessage(null);
              setLocalDemoBypass(true);
              dispatch({ type: "RESET_ALL" });
            }}
          />
        )}

        {!showAccountAccess && recordOpen && (
          <AccountRecordPage
            record={localRecord}
            accountEmail={accountSession?.user.email}
            onBack={() => setRecordOpen(false)}
            onCreator={() => setCreatorOpen(true)}
            onSupport={() => setSupportOpen(true)}
            onFeedback={() => {
              setFeedbackError(null);
              setFeedbackMessage(null);
              setFeedbackOpen(true);
            }}
          />
        )}

        {!showAccountAccess && !recordOpen && state.screen === "onboarding" && (
          <Onboarding
            nickname={nickname}
            thinkingStatus={thinkingStatus}
            isStarting={isStarting}
            onlineEnabled={Boolean(accountSession)}
            accountEmail={accountSession?.user.email}
            onNicknameChange={setNickname}
            onThinkingStatusChange={setThinkingStatus}
            onSubmit={submitProfile}
            onDemo={startDemo}
          />
        )}

        {!showAccountAccess && !recordOpen && state.screen === "matching" && (
          <SearchMatching
            nickname={state.nickname}
            elapsed={searchElapsed}
            message={searchMessage}
            demoMode={state.demoMode}
            hasError={Boolean(state.error)}
            onCancel={cancelMatching}
            onDemo={startDemo}
          />
        )}

        {!showAccountAccess && !recordOpen && state.screen === "queue" && (
          <CapacityQueue
            nickname={state.nickname}
            position={state.queuePosition ?? 1}
            elapsed={queueElapsed}
            hasError={Boolean(state.error)}
            onCancel={cancelMatching}
            onDemo={startDemo}
          />
        )}

        {!showAccountAccess && !recordOpen && state.screen === "admission" && (
          <AdmissionGate
            nickname={state.nickname}
            progress={matchProgress}
            remaining={gateRemaining}
            demoMode={state.demoMode}
            hasError={Boolean(state.error)}
            onCancel={cancelMatching}
            onDemo={startDemo}
          />
        )}

        {!showAccountAccess && !recordOpen && state.screen === "chat" && (
          <ChatRoom
            nickname={state.nickname}
            opponentLabel={state.opponentLabel}
            openingQuestions={openingQuestions}
            thinkingStatus={state.thinkingStatus}
            messages={state.messages}
            opponentTyping={state.opponentTyping}
            opponentTypingStatus={state.opponentTypingStatus}
            messageDraft={messageDraft}
            gameRemaining={gameRemaining}
            guessRemaining={guessRemaining}
            guessReady={guessReady}
            guessSubmitted={state.guessSubmitted}
            reportConfirmed={state.reportConfirmed}
            messagesEndRef={messagesEndRef}
            onMessageChange={updateMessageDraft}
            onMessageSubmit={submitMessage}
            onMessageBlur={stopTyping}
            onMessageKeyDown={handleMessageKeyDown}
            onGuess={() => setGuessOpen(true)}
            onReport={() => setReportOpen(true)}
            onLeave={() => setLeaveOpen(true)}
          />
        )}

        {!showAccountAccess &&
          !recordOpen &&
          state.screen === "finished" &&
          state.result && (
          <ResultScreen
            result={state.result}
            nickname={state.nickname}
            messageCount={state.messages.length}
            onAgain={playAgain}
            onHome={leaveGame}
          />
        )}
      </main>

      {guessOpen && (
        <GuessDialog
          target={guessTarget}
          confidence={confidence}
          isPending={pendingGuess !== null}
          onTargetChange={setGuessTarget}
          onConfidenceChange={setConfidence}
          onClose={() => setGuessOpen(false)}
          onSubmit={submitGuess}
        />
      )}

      {reportOpen && (
        <ReportDialog
          onClose={() => setReportOpen(false)}
          onSubmit={submitReport}
        />
      )}

      {leaveOpen && (
        <ConfirmDialog
          onCancel={() => setLeaveOpen(false)}
          onConfirm={leaveGame}
        />
      )}

      {supportOpen && (
        <SupportDialog onClose={() => setSupportOpen(false)} />
      )}

      {creatorOpen && (
        <CreatorDialog onClose={() => setCreatorOpen(false)} />
      )}

      {feedbackOpen && (
        <FeedbackDialog
          canSubmit={Boolean(accountSession)}
          busy={feedbackBusy}
          error={feedbackError}
          message={feedbackMessage}
          onClose={() => {
            setFeedbackOpen(false);
            setFeedbackError(null);
            setFeedbackMessage(null);
          }}
          onSubmit={handleFeedbackSubmit}
        />
      )}
    </div>
  );
}

interface AccountAccessProps {
  mode: AuthMode;
  loading: boolean;
  busy: boolean;
  error: string | null;
  message: string | null;
  hasResetToken: boolean;
  onModeChange: (mode: AuthMode) => void;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string) => Promise<void>;
  onForgotPassword: (email: string) => Promise<void>;
  onResetPassword: (newPassword: string) => Promise<void>;
  onLocalDemo: () => void;
}

function AccountAccess({
  mode,
  loading,
  busy,
  error,
  message,
  hasResetToken,
  onModeChange,
  onLogin,
  onRegister,
  onForgotPassword,
  onResetPassword,
  onLocalDemo,
}: AccountAccessProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function switchMode(nextMode: AuthMode) {
    setPassword("");
    setPasswordConfirmation("");
    setFormError(null);
    onModeChange(nextMode);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    try {
      if (mode === "forgot") {
        await onForgotPassword(email);
        return;
      }
      if (mode === "reset") {
        if (password !== passwordConfirmation) {
          setFormError("两次输入的密码不一致。");
          return;
        }
        await onResetPassword(password);
        return;
      }
      if (mode === "register") {
        if (password !== passwordConfirmation) {
          setFormError("两次输入的密码不一致。");
          return;
        }
        await onRegister(email, password);
        return;
      }
      await onLogin(email, password);
    } finally {
      setPassword("");
      setPasswordConfirmation("");
    }
  }

  const title =
    mode === "register"
      ? "创建账户"
      : mode === "forgot"
        ? "找回密码"
        : mode === "reset"
          ? "设置新密码"
          : mode === "verify"
            ? "验证邮箱"
            : "账户登录";

  return (
    <section className="account-screen page-grid" aria-busy={loading || busy}>
      <div className="account-intro">
        <p className="eyebrow">ACCOUNT GATE / OPEN REGISTRATION</p>
        <h1>
          先确认你是
          <br />
          <span>你</span>。
        </h1>
        <dl className="account-facts">
          <div>
            <dt>SESSION</dt>
            <dd>7 DAYS</dd>
          </div>
          <div>
            <dt>IDLE LIMIT</dt>
            <dd>2 HOURS</dd>
          </div>
        </dl>
      </div>

      <div className="account-panel">
        <div className="panel-number" aria-hidden="true">
          00
        </div>
        <div className="panel-heading">
          <p>SECURE ACCESS</p>
          <h2>{loading ? "正在恢复会话" : title}</h2>
        </div>

        {loading ? (
          <div className="auth-loading" role="status">
            <span />
            正在检查安全 Cookie…
          </div>
        ) : mode === "verify" ? (
          <div className="auth-result">
            <p role="alert">{error ?? "正在验证邮箱…"}</p>
            <button
              className="primary-action"
              type="button"
              onClick={() => switchMode("login")}
            >
              返回登录 <span aria-hidden="true">↗</span>
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate>
            {mode !== "reset" && (
              <label className="field">
                <span>邮箱 / EMAIL</span>
                <input
                  autoFocus
                  required
                  type="email"
                  value={email}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="redacted@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            )}

            {mode !== "forgot" && (
              <label className="field">
                <span>{mode === "reset" ? "新密码" : "密码"} / PASSWORD</span>
                <input
                  required
                  type="password"
                  value={password}
                  minLength={12}
                  maxLength={128}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  onChange={(event) => setPassword(event.target.value)}
                />
                <small>{password.length}/128</small>
              </label>
            )}

            {(mode === "register" || mode === "reset") && (
              <label className="field">
                <span>确认密码 / CONFIRM PASSWORD</span>
                <input
                  required
                  type="password"
                  value={passwordConfirmation}
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  onChange={(event) =>
                    setPasswordConfirmation(event.target.value)
                  }
                />
              </label>
            )}

            {(mode === "register" || mode === "reset") && (
              <p className="password-hint">
                使用 12–128 个字符，避免常见密码和邮箱中的个人信息。
              </p>
            )}

            {(formError || error) && (
              <p className="auth-feedback is-error" role="alert">
                {formError ?? error}
              </p>
            )}
            {message && (
              <p className="auth-feedback is-success" role="status">
                {message}
              </p>
            )}
            {mode === "reset" && !hasResetToken && (
              <p className="auth-feedback is-error" role="alert">
                重置链接无效，请重新申请。
              </p>
            )}

            <div className="form-actions">
              <button
                className="primary-action"
                type="submit"
                disabled={
                  busy || (mode === "reset" && !hasResetToken)
                }
              >
                {busy
                  ? "正在处理…"
                  : mode === "register"
                    ? "注册并验证"
                    : mode === "forgot"
                      ? "发送重置邮件"
                      : mode === "reset"
                        ? "保存新密码"
                        : "安全登录"}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </form>
        )}

        {!loading && mode !== "verify" && (
          <nav className="auth-nav" aria-label="账户操作">
            {mode !== "login" && (
              <button type="button" onClick={() => switchMode("login")}>
                返回登录
              </button>
            )}
            {mode === "login" && (
              <>
                <button type="button" onClick={() => switchMode("register")}>
                  开放注册
                </button>
                <button type="button" onClick={() => switchMode("forgot")}>
                  忘记密码
                </button>
              </>
            )}
          </nav>
        )}

        <div className="demo-bypass">
          <span>NO ACCOUNT / LOCAL ONLY</span>
          <button type="button" disabled={busy} onClick={onLocalDemo}>
            进入本地演示 →
          </button>
          <p>本地演示不会创建线上游客会话，也不会连接公共匹配。</p>
        </div>
      </div>
    </section>
  );
}

interface OnboardingProps {
  nickname: string;
  thinkingStatus: string;
  isStarting: boolean;
  onlineEnabled: boolean;
  accountEmail?: string;
  onNicknameChange: (value: string) => void;
  onThinkingStatusChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDemo: () => void;
}

function Onboarding({
  nickname,
  thinkingStatus,
  isStarting,
  onlineEnabled,
  accountEmail,
  onNicknameChange,
  onThinkingStatusChange,
  onSubmit,
  onDemo,
}: OnboardingProps) {
  return (
    <section className="onboarding page-grid">
      <div className="hero-copy">
        <p className="eyebrow">A FIVE-MINUTE SOCIAL EXPERIMENT</p>
        <h1>
          屏幕另一边
          <br />
          是<span>谁</span>？
        </h1>
        <p className="hero-description">
          和一位匿名对象对话。观察停顿、措辞和破绽，然后作出唯一一次判断：
          <strong> 真人，还是 AI。</strong>
        </p>
        <div className="hero-rules" aria-label="游戏规则">
          <span>01 / 匿名对话</span>
          <span>02 / 20 秒后判断</span>
          <span>03 / 身份揭晓</span>
        </div>
      </div>

      <form className="identity-panel" onSubmit={onSubmit}>
        <div className="panel-number" aria-hidden="true">
          01
        </div>
        <div className="panel-heading">
          <p>ENTER THE ROOM</p>
          <h2>设定你的公开身份</h2>
          {accountEmail && <span className="signed-in-as">{accountEmail}</span>}
        </div>

        <div className="identity-preview" aria-label="公开身份预览">
          <div>
            <span className="presence-mark" />
            <small>IDENTITY PREVIEW / 07</small>
          </div>
          <strong>{nickname.trim() || "未命名观察者"}</strong>
          <p>{thinkingStatus.trim() || "正在等待一个念头…"}</p>
        </div>

        <label className="field">
          <span>昵称 / NICKNAME</span>
          <input
            autoFocus
            type="text"
            value={nickname}
            minLength={2}
            maxLength={18}
            placeholder="例如：迟疑的人"
            autoComplete="nickname"
            onChange={(event) => onNicknameChange(event.target.value)}
          />
          <small>{nickname.length}/18</small>
        </label>

        <label className="field">
          <span>思考状态 / THINKING STATUS</span>
          <input
            type="text"
            value={thinkingStatus}
            minLength={2}
            maxLength={28}
            onChange={(event) => onThinkingStatusChange(event.target.value)}
          />
          <small>{thinkingStatus.length}/28</small>
        </label>

        <div className="suggestion-row" aria-label="思考状态建议">
          {THINKING_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className={thinkingStatus === suggestion ? "is-selected" : ""}
              onClick={() => onThinkingStatusChange(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="form-actions">
          <button
            className="primary-action"
            type="submit"
            disabled={isStarting || !onlineEnabled}
          >
            {isStarting
              ? "正在连接…"
              : onlineEnabled
                ? "进入匹配"
                : "登录后在线匹配"}
            <span aria-hidden="true">↗</span>
          </button>
          <button
            className="demo-action"
            type="button"
            disabled={isStarting}
            onClick={onDemo}
          >
            <span>本地演示</span>
            <small>无需账户 · 约 5 分钟</small>
          </button>
        </div>

        <p className="privacy-note">
          继续即表示你同意文明交流。不要发送真实姓名、地址或联系方式。
        </p>
      </form>
    </section>
  );
}

interface MatchingActionsProps {
  demoMode: boolean;
  hasError: boolean;
  onCancel: () => void;
  onDemo: () => void;
}

function MatchingActions({
  demoMode,
  hasError,
  onCancel,
  onDemo,
}: MatchingActionsProps) {
  return (
    <div className="matching-actions">
      {hasError && !demoMode && (
        <button className="primary-action compact" type="button" onClick={onDemo}>
          切换本地演示 <span aria-hidden="true">↗</span>
        </button>
      )}
      <button className="text-action" type="button" onClick={onCancel}>
        取消匹配
      </button>
    </div>
  );
}

interface CapacityQueueProps extends Omit<MatchingActionsProps, "demoMode"> {
  nickname: string;
  position: number;
  elapsed: number;
}

function CapacityQueue({
  nickname,
  position,
  elapsed,
  hasError,
  onCancel,
  onDemo,
}: CapacityQueueProps) {
  return (
    <section className="matching-screen phase-screen queue-screen">
      <div className="matching-meta">
        <span>WAITING LINE</span>
        <span>已等待 {formatClock(elapsed)}</span>
      </div>
      <div className="matching-core phase-core">
        <div className="matching-count queue-position" aria-live="polite">
          {String(position).padStart(2, "0")}
        </div>
        <div className="phase-copy">
          <p className="eyebrow">PLAYER / {nickname.toUpperCase()}</p>
          <h1>
            正在为你
            <br />
            <span>安排席位</span>
          </h1>
          <p>
            当前参与者较多。保持页面开启，轮到你时会自动进入匹配。
          </p>
        </div>
      </div>
      <div className="queue-status" role="status" aria-live="polite">
        <span>QUEUE POSITION</span>
        <strong>前方还有 {Math.max(0, position - 1)} 位参与者</strong>
      </div>
      <MatchingActions
        demoMode={false}
        hasError={hasError}
        onCancel={onCancel}
        onDemo={onDemo}
      />
    </section>
  );
}

interface SearchMatchingProps extends MatchingActionsProps {
  nickname: string;
  elapsed: number;
  message: string;
}

function SearchMatching({
  nickname,
  elapsed,
  message,
  demoMode,
  hasError,
  onCancel,
  onDemo,
}: SearchMatchingProps) {
  return (
    <section className="matching-screen phase-screen search-screen">
      <div className="matching-meta">
        <span>OPPONENT SEARCH</span>
        <span>{demoMode ? "本地演示通道" : "匿名公共通道"}</span>
      </div>
      <div className="matching-core phase-core">
        <div className="search-orbit" aria-hidden="true">
          <span />
          <span />
          <strong>?</strong>
        </div>
        <div className="phase-copy">
          <p className="eyebrow">PLAYER / {nickname.toUpperCase()}</p>
          <h1>
            正在寻找
            <br />
            <span>你的对手</span>
          </h1>
          <p className="search-message" role="status" aria-live="polite">
            {message}
          </p>
        </div>
      </div>
      <div className="search-status">
        <span className="search-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>搜索已进行 {formatClock(elapsed)}</span>
      </div>
      <MatchingActions
        demoMode={demoMode}
        hasError={hasError}
        onCancel={onCancel}
        onDemo={onDemo}
      />
    </section>
  );
}

interface AdmissionGateProps {
  nickname: string;
  progress: number;
  remaining: number;
  demoMode: boolean;
  hasError: boolean;
  onCancel: () => void;
  onDemo: () => void;
}

function AdmissionGate({
  nickname,
  progress,
  remaining,
  demoMode,
  hasError,
  onCancel,
  onDemo,
}: AdmissionGateProps) {
  const progressPercent = Math.round(progress * 100);
  const connectionStage =
    progressPercent < 25
      ? "建立安全通道"
      : progressPercent < 55
        ? "同步匿名身份"
        : progressPercent < 90
          ? "等待对象确认"
          : "锁定对话房间";

  return (
    <section className="matching-screen">
      <div className="matching-meta">
        <span>ROOM CONNECTION</span>
        <span>{demoMode ? "本地演示通道" : "匿名公共通道"}</span>
      </div>
      <div className="matching-core">
        <div className="matching-count" aria-live="polite">
          {Math.max(0, Math.ceil(remaining / 1_000))
            .toString()
            .padStart(2, "0")}
        </div>
        <div>
          <p className="eyebrow">PLAYER / {nickname.toUpperCase()}</p>
          <h1>
            等待对象
            <br />
            <span>进入房间</span>
          </h1>
        </div>
      </div>
      <div className="calibration">
        <div className="calibration-label">
          <span>{connectionStage}</span>
          <span>{progressPercent}%</span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
        >
          <div style={{ transform: `scaleX(${progress})` }} />
        </div>
        <div className="connection-steps" aria-hidden="true">
          {["安全通道", "匿名身份", "对象确认", "房间锁定"].map(
            (label, index) => (
              <span
                key={label}
                className={progressPercent >= index * 25 ? "is-active" : ""}
              >
                <i>{String(index + 1).padStart(2, "0")}</i>
                {label}
              </span>
            ),
          )}
        </div>
      </div>
      <MatchingActions
        demoMode={demoMode}
        hasError={hasError}
        onCancel={onCancel}
        onDemo={onDemo}
      />
    </section>
  );
}

interface ChatRoomProps {
  nickname: string;
  opponentLabel: string;
  openingQuestions: string[];
  thinkingStatus: string;
  messages: ChatMessage[];
  opponentTyping: boolean;
  opponentTypingStatus: string;
  messageDraft: string;
  gameRemaining: number;
  guessRemaining: number;
  guessReady: boolean;
  guessSubmitted: GuessTarget | null;
  reportConfirmed: boolean;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onMessageChange: (value: string) => void;
  onMessageSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onMessageBlur: () => void;
  onMessageKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onGuess: () => void;
  onReport: () => void;
  onLeave: () => void;
}

function ChatRoom({
  nickname,
  opponentLabel,
  openingQuestions,
  thinkingStatus,
  messages,
  opponentTyping,
  opponentTypingStatus,
  messageDraft,
  gameRemaining,
  guessRemaining,
  guessReady,
  guessSubmitted,
  reportConfirmed,
  messagesEndRef,
  onMessageChange,
  onMessageSubmit,
  onMessageBlur,
  onMessageKeyDown,
  onGuess,
  onReport,
  onLeave,
}: ChatRoomProps) {
  return (
    <section className="chat-layout">
      <aside className="chat-sidebar">
        <div>
          <p className="eyebrow">ACTIVE ROOM / 01</p>
          <h1>观察。<br />试探。<br /><span>判断。</span></h1>
        </div>
        <dl className="session-facts">
          <div>
            <dt>你</dt>
            <dd>{nickname}</dd>
          </div>
          <div>
            <dt>对方</dt>
            <dd>{opponentLabel}</dd>
          </div>
          <div>
            <dt>剩余时间</dt>
            <dd className="tabular">{formatClock(gameRemaining)}</dd>
          </div>
          <div>
            <dt>消息数</dt>
            <dd>{messages.length.toString().padStart(2, "0")}</dd>
          </div>
        </dl>
        <div className="sidebar-actions">
          <button
            className="guess-action"
            type="button"
            disabled={!guessReady || Boolean(guessSubmitted)}
            onClick={onGuess}
          >
            {!guessSubmitted && (
              <span
                className="guess-progress"
                style={{
                  transform: `scaleX(${guessReady ? 1 : Math.max(0, 1 - guessRemaining / 20_000)})`,
                }}
                aria-hidden="true"
              />
            )}
            <span>
              {guessSubmitted
                ? "判断已锁定"
                : guessReady
                  ? "作出判断 ↗"
                  : `${Math.ceil(guessRemaining / 1_000)} 秒后可判断`}
            </span>
          </button>
          <div>
            <button
              className="quiet-action"
              type="button"
              disabled={reportConfirmed}
              onClick={onReport}
            >
              {reportConfirmed ? "已举报" : "举报"}
            </button>
            <button className="quiet-action" type="button" onClick={onLeave}>
              离开
            </button>
          </div>
        </div>
      </aside>

      <div className="chat-stage">
        <header className="conversation-header">
          <div>
            <span className="presence-mark" />
            <strong>{opponentLabel}</strong>
          </div>
          <p>身份将在判断后揭晓</p>
        </header>

        <div
          className="message-list"
          role="log"
          tabIndex={0}
          aria-live="polite"
          aria-label="对话消息，可上下滚动"
        >
          {messages.length === 0 && (
            <div className="conversation-empty">
              <span className="empty-index">NO SIGNAL / START WITH A QUESTION</span>
              <h2>别从“你好”开始。</h2>
              <p>选择一个不容易被模板回答的问题，观察对方如何犹豫。</p>
              <div className="opening-questions" aria-label="开场问题建议">
                {openingQuestions.map((question, index) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => onMessageChange(question)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {question}
                    <i aria-hidden="true">↘</i>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className={`message is-${message.sender}`}
            >
              <div className="message-meta">
                <span>
                  {message.sender === "self"
                    ? nickname
                    : message.sender === "opponent"
                      ? opponentLabel
                      : "SYSTEM"}
                </span>
                <time dateTime={new Date(message.createdAt).toISOString()}>
                  {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p>{message.content}</p>
            </article>
          ))}
          {opponentTyping && (
            <div className="typing-indicator" role="status">
              <div>
                <span />
                <span />
                <span />
              </div>
              {opponentTypingStatus || thinkingStatus}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={onMessageSubmit}>
          <div className="composer-heading">
            <label htmlFor="message">你的消息</label>
            <span>{guessSubmitted ? "CONVERSATION LOCKED" : "ENCRYPTED CHANNEL"}</span>
          </div>
          <textarea
            id="message"
            value={messageDraft}
            maxLength={100}
            rows={2}
            disabled={Boolean(guessSubmitted)}
            placeholder={
              guessSubmitted ? "判断已提交，对话已冻结。" : "输入一个问题…"
            }
            onChange={(event) => onMessageChange(event.target.value)}
            onBlur={onMessageBlur}
            onKeyDown={onMessageKeyDown}
          />
          <div className="composer-footer">
            <span>{messageDraft.length}/100 · ENTER 发送 / SHIFT+ENTER 换行</span>
            <button
              type="submit"
              disabled={!messageDraft.trim() || Boolean(guessSubmitted)}
              aria-label="发送消息"
            >
              发送 <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

interface GuessDialogProps {
  target: GuessTarget;
  confidence: number;
  isPending: boolean;
  onTargetChange: (target: GuessTarget) => void;
  onConfidenceChange: (confidence: number) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function GuessDialog({
  target,
  confidence,
  isPending,
  onTargetChange,
  onConfidenceChange,
  onClose,
  onSubmit,
}: GuessDialogProps) {
  useEscapeToClose(onClose);
  const confidenceLabel =
    confidence < 60 ? "仍在犹豫" : confidence < 80 ? "明显倾向" : "非常确信";

  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        className="modal guess-modal"
        open
        aria-modal="true"
        aria-labelledby="guess-title"
      >
        <button
          autoFocus
          className="modal-close"
          type="button"
          aria-label="关闭"
          onClick={onClose}
        >
          ×
        </button>
        <p className="eyebrow">FINAL DECISION / ONLY ONCE</p>
        <h2 id="guess-title">屏幕另一边是谁？</h2>
        <p className="modal-lead">提交后无法修改，对话也会立即冻结。</p>
        <form onSubmit={onSubmit}>
          <div className="identity-choice">
            <label className={target === "human" ? "is-active" : ""}>
              <input
                type="radio"
                name="guess"
                value="human"
                checked={target === "human"}
                onChange={() => onTargetChange("human")}
              />
              <span className="choice-index">A</span>
              <strong>真人</strong>
              <small>HUMAN</small>
            </label>
            <label className={target === "ai" ? "is-active" : ""}>
              <input
                type="radio"
                name="guess"
                value="ai"
                checked={target === "ai"}
                onChange={() => onTargetChange("ai")}
              />
              <span className="choice-index">B</span>
              <strong>AI</strong>
              <small>MACHINE</small>
            </label>
          </div>
          <label className="confidence-field">
            <span>
              你的把握 / CONFIDENCE
              <strong>
                {confidenceLabel} · {confidence}%
              </strong>
            </span>
            <input
              type="range"
              min={50}
              max={100}
              step={1}
              value={confidence}
              onChange={(event) =>
                onConfidenceChange(Number(event.target.value))
              }
            />
          </label>
          <button className="primary-action" type="submit" disabled={isPending}>
            {isPending ? "正在锁定…" : "锁定判断"}
            <span aria-hidden="true">↗</span>
          </button>
        </form>
      </dialog>
    </div>
  );
}

function ReportDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  useEscapeToClose(onClose);
  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        className="modal report-modal"
        open
        aria-modal="true"
        aria-labelledby="report-title"
      >
        <button
          autoFocus
          className="modal-close"
          type="button"
          aria-label="关闭"
          onClick={onClose}
        >
          ×
        </button>
        <p className="eyebrow">SAFETY / REPORT</p>
        <h2 id="report-title">举报本局内容</h2>
        <p className="modal-lead">
          举报不会通知对方。当前对话证据会被安全保存并进入复核。
        </p>
        <form onSubmit={onSubmit}>
          <label className="field">
            <span>原因</span>
            <select name="reason" defaultValue="harassment">
              <option value="harassment">骚扰或侮辱</option>
              <option value="sexual">色情或性暗示</option>
              <option value="personal_info">索要或泄露个人信息</option>
              <option value="self_harm">自伤或危险行为</option>
              <option value="spam">垃圾信息或广告</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label className="field">
            <span>补充说明（可选）</span>
            <textarea name="details" maxLength={300} rows={4} />
          </label>
          <div className="modal-actions">
            <button className="primary-action" type="submit">
              提交举报
            </button>
            <button className="text-action" type="button" onClick={onClose}>
              取消
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function ConfirmDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEscapeToClose(onCancel);
  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        className="modal confirm-modal"
        open
        aria-modal="true"
        aria-labelledby="leave-title"
      >
        <p className="eyebrow">LEAVE ROOM</p>
        <h2 id="leave-title">确定离开本局？</h2>
        <p className="modal-lead">离开后无法返回，本局可能被记为中途退出。</p>
        <div className="modal-actions">
          <button className="danger-action" type="button" onClick={onConfirm}>
            确认离开
          </button>
          <button
            autoFocus
            className="text-action"
            type="button"
            onClick={onCancel}
          >
            继续对话
          </button>
        </div>
      </dialog>
    </div>
  );
}

function AccountRecordPage({
  record,
  accountEmail,
  onBack,
  onCreator,
  onSupport,
  onFeedback,
}: {
  record: LocalPlayerRecord;
  accountEmail?: string;
  onBack: () => void;
  onCreator: () => void;
  onSupport: () => void;
  onFeedback: () => void;
}) {
  return (
    <section className="record-page">
      <div className="record-page-heading">
        <button className="record-back" type="button" onClick={onBack}>
          ← 返回实验
        </button>
        <div>
          <p>PLAYER FILE / LOCAL RECORD</p>
          <h1>对局记录</h1>
          <span>{accountEmail || "本地演示身份"}</span>
        </div>
        <p>
          每次判断都会留下一个观察切片。当前记录仅保存在这台设备，
          不会跨浏览器同步。
        </p>
      </div>

      <div className="record-overview">
        <dl className="record-stats">
          <div>
            <dt>LOCAL RECORD / 完成局数</dt>
            <dd>{String(record.rounds).padStart(2, "0")}</dd>
          </div>
          <div>
            <dt>HIT RATE / 判断命中</dt>
            <dd>{hitRate(record)}%</dd>
          </div>
          <div>
            <dt>TOTAL SCORE / 累计得分</dt>
            <dd>{record.totalScore}</dd>
          </div>
        </dl>
        <div className="creator-actions">
          <button
            className="primary-action"
            type="button"
            onClick={onCreator}
          >
            去围观作者吧 ( •̀ ω •́ )✧
            <span aria-hidden="true">↗</span>
          </button>
          <button className="support-action" type="button" onClick={onSupport}>
            请作者喝杯奶茶叭 ☕
          </button>
          <button className="feedback-action" type="button" onClick={onFeedback}>
            发现 Bug？来投喂反馈喵
          </button>
        </div>
      </div>

      <div className="record-history">
        <div className="record-history-title">
          <div>
            <span>MATCH ARCHIVE</span>
            <h2>历史战绩</h2>
          </div>
          <strong>{record.games.length} 条本机记录</strong>
        </div>
        {record.games.length === 0 ? (
          <div className="record-empty">
            <span>NO SIGNAL YET / 000</span>
            <strong>还没有对局记录</strong>
            <p>
              完成第一次判断后，这里就会留下观察记录啦 ฅ( ̳• ·̫ • ̳ฅ)
            </p>
            <button className="text-action" type="button" onClick={onBack}>
              先去完成第一局叭 →
            </button>
          </div>
        ) : (
          <ol className="record-game-list">
            {record.games.map((game, index) => (
              <li
                key={game.id}
                className={game.isCorrect ? "is-correct" : "is-wrong"}
              >
                <div className="record-game-index" aria-hidden="true">
                  {String(record.games.length - index).padStart(3, "0")}
                </div>
                <div className="record-game-result">
                  <span>{game.isCorrect ? "判断命中" : "判断偏差"}</span>
                  <strong>{game.isCorrect ? "✓" : "×"}</strong>
                </div>
                <dl>
                  <div>
                    <dt>真实身份</dt>
                    <dd>{game.opponentType === "human" ? "真人" : "AI"}</dd>
                  </div>
                  <div>
                    <dt>你的判断</dt>
                    <dd>
                      {game.guess === null
                        ? "未提交"
                        : game.guess === "human"
                          ? "真人"
                          : "AI"}
                    </dd>
                  </div>
                  <div>
                    <dt>对话消息</dt>
                    <dd>{game.messageCount}</dd>
                  </div>
                  <div>
                    <dt>持续时间</dt>
                    <dd>{formatRecordDuration(game.durationSeconds)}</dd>
                  </div>
                </dl>
                <div className="record-game-meta">
                  <time dateTime={new Date(game.finishedAt).toISOString()}>
                    {formatRecordDate(game.finishedAt)}
                  </time>
                  <strong>+{game.scoreDelta}</strong>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function formatRecordDate(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatRecordDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(
    safeSeconds % 60,
  ).padStart(2, "0")}`;
}

function SupportDialog({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose);
  return (
    <div className="modal-backdrop support-backdrop" role="presentation">
      <dialog
        className="modal support-modal"
        open
        aria-modal="true"
        aria-labelledby="support-title"
      >
        <button
          className="modal-close"
          type="button"
          aria-label="关闭支持作者弹窗"
          onClick={onClose}
        >
          ×
        </button>
        <div className="support-avatar" aria-hidden="true">
          ☕
        </div>
        <span className="support-thanks">THANK YOU!</span>
        <h2 id="support-title">请作者喝杯奶茶叭</h2>
        <p>
          谢谢你喜欢这个小实验呀，微信或支付宝任选一个，量力支持就好喵
          ฅ(˵ •̀ ᴗ - ˵ ) ✧
        </p>
        <div className="support-code-list" aria-label="作者收款码">
          <figure className="support-code-card is-wechat">
            <img
              src="/support/wechat-pay.jpg"
              alt="微信支付收款码"
            />
            <figcaption>
              <strong>微信支付</strong>
              <span>打开微信扫一扫</span>
            </figcaption>
          </figure>
          <figure className="support-code-card is-alipay">
            <img
              src="/support/alipay.jpg"
              alt="支付宝收款码"
            />
            <figcaption>
              <strong>支付宝</strong>
              <span>打开支付宝扫一扫</span>
            </figcaption>
          </figure>
        </div>
        <button className="support-close-action" type="button" onClick={onClose}>
          好哒，下次一定
        </button>
      </dialog>
    </div>
  );
}

function CreatorDialog({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose);
  return (
    <div className="modal-backdrop creator-backdrop" role="presentation">
      <dialog
        className="modal creator-modal"
        open
        aria-modal="true"
        aria-labelledby="creator-title"
      >
        <button
          className="modal-close"
          type="button"
          aria-label="关闭关注作者弹窗"
          onClick={onClose}
        >
          ×
        </button>
        <p className="creator-kicker">FOLLOW THE CREATOR / 02</p>
        <h2 id="creator-title">来找作者玩叭</h2>
        <p>
          开发碎片、更新进度和偶尔掉落的脑洞，都在这里等你喵
          ฅ(˵ •̀ ᴗ - ˵ ) ✧
        </p>
        <div className="creator-link-list">
          <a
            className="creator-platform is-bilibili"
            href={BILIBILI_SPACE_URL}
            target="_blank"
            rel="noreferrer"
          >
            <span>BILIBILI / 哔哩哔哩</span>
            <strong>去 B 站关注作者</strong>
            <i aria-hidden="true">↗</i>
          </a>
          <a
            className="creator-platform is-douyin"
            href={DOUYIN_SPACE_URL}
            target="_blank"
            rel="noreferrer"
          >
            <span>DOUYIN / 抖音</span>
            <strong>去抖音看看作者</strong>
            <i aria-hidden="true">↗</i>
          </a>
        </div>
        <button className="support-close-action" type="button" onClick={onClose}>
          好哒，晚点去逛
        </button>
      </dialog>
    </div>
  );
}

function FeedbackDialog({
  canSubmit,
  busy,
  error,
  message,
  onClose,
  onSubmit,
}: {
  canSubmit: boolean;
  busy: boolean;
  error: string | null;
  message: string | null;
  onClose: () => void;
  onSubmit: (input: {
    category: FeedbackCategory;
    title: string;
    details: string;
  }) => Promise<void>;
}) {
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  useEscapeToClose(onClose);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit({ category, title, details });
  }

  return (
    <div className="modal-backdrop feedback-backdrop" role="presentation">
      <dialog
        className="modal feedback-modal"
        open
        aria-modal="true"
        aria-labelledby="feedback-title"
      >
        <button
          className="modal-close"
          type="button"
          aria-label="关闭反馈弹窗"
          onClick={onClose}
        >
          ×
        </button>
        <p className="feedback-kicker">BUG REPORT / IDEA DROP</p>
        <h2 id="feedback-title">投喂一点反馈吧</h2>
        {message ? (
          <div className="feedback-success" role="status">
            <span aria-hidden="true">✓</span>
            <strong>{message}</strong>
            <p>
              已经安全排进每日反馈汇总，作者会认真看完每一条哒
              (ง •̀_•́)ง
            </p>
            <button
              className="support-close-action"
              type="button"
              onClick={onClose}
            >
              好耶，关闭
            </button>
          </div>
        ) : (
          <form className="feedback-form" onSubmit={submit}>
            <p>
              Bug、奇怪体验和灵光一闪都可以写。请不要填写密码、验证码或其他隐私信息喵。
            </p>
            <fieldset disabled={busy || !canSubmit}>
              <legend>反馈类型</legend>
              <div className="feedback-category">
                {([
                  ["bug", "发现 Bug"],
                  ["suggestion", "功能建议"],
                  ["other", "其他想法"],
                ] as const).map(([value, label]) => (
                  <label
                    key={value}
                    className={category === value ? "is-selected" : ""}
                  >
                    <input
                      type="radio"
                      name="feedback-category"
                      value={value}
                      checked={category === value}
                      onChange={() => setCategory(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label className="field">
                <span>一句话标题 / TITLE</span>
                <input
                  type="text"
                  minLength={2}
                  maxLength={80}
                  value={title}
                  placeholder="例如：手机横屏时按钮被挡住了"
                  onChange={(event) => setTitle(event.target.value)}
                />
                <small>{title.length}/80</small>
              </label>
              <label className="field">
                <span>详细描述 / DETAILS</span>
                <textarea
                  minLength={10}
                  maxLength={2000}
                  rows={6}
                  value={details}
                  placeholder="发生了什么、你原本期待什么？如果能写下复现步骤就更好啦。"
                  onChange={(event) => setDetails(event.target.value)}
                />
                <small>{details.length}/2000</small>
              </label>
            </fieldset>
            {!canSubmit && (
              <p className="feedback-login-note" role="note">
                当前是本地演示身份。登录账户后，反馈才可以安全送到作者邮箱喵。
              </p>
            )}
            {error && (
              <p className="feedback-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-action"
              type="submit"
              disabled={
                busy ||
                !canSubmit ||
                title.trim().length < 2 ||
                details.trim().length < 10
              }
            >
              {busy ? "正在提交 ing…" : "提交反馈喵"}
              <span aria-hidden="true">↗</span>
            </button>
          </form>
        )}
      </dialog>
    </div>
  );
}

function ResultScreen({
  result,
  nickname,
  messageCount,
  onAgain,
  onHome,
}: {
  result: GameResult;
  nickname: string;
  messageCount: number;
  onAgain: () => void;
  onHome: () => void;
}) {
  return (
    <section className={`result-screen ${result.isCorrect ? "is-win" : "is-loss"}`}>
      <div className="result-kicker">
        <span>IDENTITY REVEALED</span>
        <span>{result.isCorrect ? "判断成立" : "判断偏差"}</span>
      </div>
      <div className="result-identity">
        <p className="result-step">02 / 真实身份</p>
        <p>屏幕另一边是</p>
        <h1>{result.opponentType === "human" ? "真人" : "AI"}</h1>
        <span aria-hidden="true">
          {result.opponentType === "human" ? "HUMAN" : "MACHINE"}
        </span>
      </div>
      <div className="result-verdict">
        <div className="verdict-mark" aria-hidden="true">
          {result.isCorrect ? "✓" : "×"}
        </div>
        <div>
          <p className="result-step">01 / 你的判断</p>
          <p>{nickname}，你判断对方是</p>
          <strong>
            {result.guess === null
              ? "未提交"
              : result.guess === "human"
                ? "真人"
                : "AI"}
          </strong>
          <span>{result.isCorrect ? "你的判断正确。" : "这次，对方骗过了你。"}</span>
        </div>
      </div>
      <dl className="result-stats">
        <div>
          <dt>对话消息</dt>
          <dd>{result.stats?.messageCount ?? messageCount}</dd>
        </div>
        <div>
          <dt>本局得分</dt>
          <dd>+{result.stats?.scoreDelta ?? (result.isCorrect ? 12 : 0)}</dd>
        </div>
        <div>
          <dt>当前连胜</dt>
          <dd>{result.stats?.streak ?? (result.isCorrect ? 1 : 0)}</dd>
        </div>
      </dl>
      <div className="result-actions">
        <button className="primary-action" type="button" onClick={onAgain}>
          再来一局 <span aria-hidden="true">↗</span>
        </button>
        <button className="text-action" type="button" onClick={onHome}>
          返回首页
        </button>
      </div>
    </section>
  );
}
