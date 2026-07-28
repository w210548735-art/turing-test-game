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
  EMPTY_LOCAL_RECORD,
  hitRate,
  localRecordKey,
  readLocalRecord,
  recordFinishedGame,
  type LocalPlayerRecord,
  writeLocalRecord,
} from "./local-record";
import { pickOpeningQuestions } from "./opening-questions";
import {
  shouldStartTypingHeartbeat,
  shouldStopTyping,
  TYPING_HEARTBEAT_INTERVAL_MS,
  TYPING_IDLE_TIMEOUT_MS,
} from "./typing-heartbeat";
import { ArchiveConsentDialog } from "./echo-archive/ArchiveConsentDialog";
import { EchoArchivePage } from "./echo-archive/EchoArchivePage";
import {
  PlayerRecordsPage,
  type RecordMode,
} from "./records/PlayerRecordsPage";
import { AccountSettingsPage } from "./account/AccountSettingsPage";
import { AdminDashboardPage } from "./admin/AdminDashboardPage";
import {
  bootstrapAccount,
  changeAccountPassword,
  deleteAccount,
  DemoTransport,
  forgotAccountPassword,
  fetchAdminDashboard,
  loginAccount,
  logoutAccount,
  type AccountSessionResponse,
  type AdminDashboardResponse,
  type GameTransport,
  OnlineTransport,
  registerAccount,
  resendAccountVerification,
  resetAccountPassword,
  saveProfile,
  saveAccountProfile,
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
  "正在为你寻找一个尚未署名的声音",
  "正在扫描此刻在线的匿名信号",
  "有些答案，值得让沉默先发生",
  "正在把两段陌生的语言带进同一个房间",
];

const BILIBILI_SPACE_URL =
  "https://space.bilibili.com/485008770?spm_id_from=333.1007.0.0";
const DOUYIN_SPACE_URL = "https://v.douyin.com/l_xBqIYez08/";
const GITHUB_PROJECT_URL =
  "https://github.com/w210548735-art/turing-test-game";

type AuthMode =
  | "login"
  | "register"
  | "resend"
  | "forgot"
  | "reset"
  | "verify";
type ActiveView = "game" | "records" | "settings" | "echo" | "admin";

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
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("game");
  const [adminData, setAdminData] =
    useState<AdminDashboardResponse | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [recordMode, setRecordMode] = useState<RecordMode>("duel");
  const [archiveConsentGameId, setArchiveConsentGameId] =
    useState<string | null>(null);
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
  const typingHeartbeatRef = useRef<number | null>(null);
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

  const refreshAdminDashboard = useCallback(async () => {
    if (accountSession?.user.role !== "ROOT") return;
    setAdminLoading(true);
    setAdminError(null);
    try {
      setAdminData(await fetchAdminDashboard());
    } catch (error) {
      setAdminError(
        error instanceof Error ? error.message : "运营数据加载失败。",
      );
    } finally {
      setAdminLoading(false);
    }
  }, [accountSession?.user.role]);

  useEffect(() => {
    if (activeView !== "admin") return;
    if (accountSession?.user.role !== "ROOT") {
      setActiveView("settings");
      return;
    }
    void refreshAdminDashboard();
    const timer = window.setInterval(() => {
      void refreshAdminDashboard();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activeView, accountSession?.user.role, refreshAdminDashboard]);

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
      if (typingHeartbeatRef.current !== null) {
        window.clearInterval(typingHeartbeatRef.current);
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
          if (
            event.archiveConsentEligible &&
            !stateRef.current.demoMode &&
            stateRef.current.gameId
          ) {
            setArchiveConsentGameId(stateRef.current.gameId);
          }
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

  const handleResendVerification = useCallback(async (email: string) => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthMessage(null);
    try {
      const result = await resendAccountVerification({ email });
      setAuthMessage(
        result.message || "如果账户仍待验证，新的验证邮件将很快送达。",
      );
      setAuthMode("login");
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "无法重新发送验证邮件。",
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
      setActiveView("game");
      setArchiveConsentGameId(null);
      dispatch({ type: "RESET_ALL" });
      setAuthMode("login");
      setAuthMessage("已安全退出当前会话。");
      setLogoutOpen(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "退出失败。");
      setLogoutOpen(false);
    } finally {
      setAuthBusy(false);
    }
  }, [accountSession]);

  const handleDisplayNameSave = useCallback(
    async (displayName: string) => {
      if (!accountSession) {
        throw new Error("请先登录账户，再修改全局名称。");
      }
      const user = await saveAccountProfile(accountSession.csrfToken, {
        displayName,
      });
      setAccountSession((current) =>
        current ? { ...current, user } : current,
      );
    },
    [accountSession],
  );

  const handleChangePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!accountSession) {
        throw new Error("请先登录账户，再修改密码。");
      }
      await changeAccountPassword(accountSession.csrfToken, {
        currentPassword,
        newPassword,
      });
    },
    [accountSession],
  );

  const handleDeleteAccount = useCallback(
    async (currentPassword: string, confirmation: string) => {
      if (!accountSession) {
        throw new Error("请先登录账户，再执行账号注销。");
      }
      if (confirmation !== "注销") {
        throw new Error("请输入“注销”完成确认。");
      }

      const deletedRecordKey = localRecordKey(accountSession.user.id);
      await deleteAccount(accountSession.csrfToken, {
        currentPassword,
        confirmation,
      });

      transportRef.current?.close();
      transportRef.current = null;
      try {
        window.localStorage.removeItem(deletedRecordKey);
      } catch {
        // 浏览器禁用本地存储时，服务端注销仍然有效。
      }
      setLocalRecord({ ...EMPTY_LOCAL_RECORD, games: [] });
      setAccountSession(null);
      setLocalDemoBypass(false);
      setNickname("");
      setActiveView("game");
      setRecordMode("duel");
      setArchiveConsentGameId(null);
      dispatch({ type: "RESET_ALL" });
      setAuthMode("login");
      setAuthMessage("账号已注销，相关身份已经匿名化。");
    },
    [accountSession],
  );

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
              ? `${error.message} 你可以切换到教学模式继续体验。`
              : "启动失败，你可以切换到教学模式继续体验。",
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
    if (!content) {
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
    if (shouldStopTyping(value)) {
      stopTyping();
      return;
    }
    if (!hasSentTypingRef.current) {
      sendSafely({ type: "chat.typing_start" });
      hasSentTypingRef.current = true;
    }
    if (
      shouldStartTypingHeartbeat(
        value,
        typingHeartbeatRef.current !== null,
      )
    ) {
      typingHeartbeatRef.current = window.setInterval(() => {
        if (hasSentTypingRef.current) {
          sendSafely({ type: "chat.typing_start" });
        }
      }, TYPING_HEARTBEAT_INTERVAL_MS);
    }
    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = window.setTimeout(
      stopTyping,
      TYPING_IDLE_TIMEOUT_MS,
    );
  }

  function stopTyping() {
    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (typingHeartbeatRef.current !== null) {
      window.clearInterval(typingHeartbeatRef.current);
      typingHeartbeatRef.current = null;
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
    setArchiveConsentGameId(null);
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
    setActiveView("game");
  }

  function leaveGame() {
    sendSafely({ type: "game.leave" });
    transportRef.current?.close();
    transportRef.current = null;
    setLeaveOpen(false);
    dispatch({ type: "RESET_ALL" });
    setNickname("");
    setActiveView("game");
    setArchiveConsentGameId(null);
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
    if (state.demoMode) return "TEACHING";
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
            activeView === "game" &&
            (state.screen === "onboarding" || state.screen === "finished") && (
            <button
              className="header-record"
              type="button"
              onClick={() => {
                setRecordMode("duel");
                setActiveView("records");
              }}
            >
              <span>玩家档案</span>
              <strong className="header-player-name">
                {accountSession?.user.displayName || "教学模式"}
              </strong>
              <strong className="header-player-record">
                {String(localRecord.rounds).padStart(2, "0")} 局 ·{" "}
                {hitRate(localRecord)}%
              </strong>
            </button>
          )}
          {!showAccountAccess &&
            activeView === "game" &&
            accountSession &&
            state.screen !== "onboarding" &&
            state.screen !== "finished" && (
            <div className="header-account-label">
              <strong>{accountSession.user.displayName}</strong>
              <span>NO. {accountSession.user.playerNumber}</span>
            </div>
          )}
          {accountSession && (
            <button
              className="header-logout"
              type="button"
              disabled={authBusy}
              onClick={() => setLogoutOpen(true)}
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
            onResendVerification={handleResendVerification}
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

        {!showAccountAccess && activeView === "records" && (
          <PlayerRecordsPage
            record={localRecord}
            accountUser={accountSession?.user}
            mode={recordMode}
            onModeChange={setRecordMode}
            onBack={() => setActiveView("game")}
            onSettings={() => {
              if (accountSession) {
                setActiveView("settings");
                return;
              }
              setLocalDemoBypass(false);
              setAuthMode("login");
            }}
          />
        )}

        {!showAccountAccess &&
          activeView === "settings" &&
          accountSession && (
          <AccountSettingsPage
            accountUser={accountSession.user}
            busy={authBusy}
            onBack={() => setActiveView("records")}
            onSaveDisplayName={handleDisplayNameSave}
            onChangePassword={handleChangePassword}
            onLogout={() => setLogoutOpen(true)}
            onDeleteAccount={handleDeleteAccount}
            onAdmin={
              accountSession.user.role === "ROOT"
                ? () => setActiveView("admin")
                : undefined
            }
            onCreator={() => setCreatorOpen(true)}
            onSupport={() => setSupportOpen(true)}
            onFeedback={() => {
              setFeedbackError(null);
              setFeedbackMessage(null);
              setFeedbackOpen(true);
            }}
          />
        )}

        {!showAccountAccess &&
          activeView === "admin" &&
          accountSession?.user.role === "ROOT" && (
          <AdminDashboardPage
            data={adminData}
            loading={adminLoading}
            error={adminError}
            onBack={() => setActiveView("settings")}
            onRefresh={() => void refreshAdminDashboard()}
          />
        )}

        {!showAccountAccess &&
          activeView === "echo" &&
          accountSession && (
          <EchoArchivePage
            csrfToken={accountSession.csrfToken}
            onBack={() => setActiveView("game")}
            onOpenRecords={() => {
              setRecordMode("echo");
              setActiveView("records");
            }}
          />
        )}

        {!showAccountAccess && activeView === "game" && state.screen === "onboarding" && (
          <Onboarding
            nickname={nickname}
            thinkingStatus={thinkingStatus}
            isStarting={isStarting}
            onlineEnabled={Boolean(accountSession)}
            tutorialMode={!accountSession && localDemoBypass}
            accountIdentity={
              accountSession
                ? `${accountSession.user.displayName} · NO. ${accountSession.user.playerNumber}`
                : undefined
            }
            onNicknameChange={setNickname}
            onThinkingStatusChange={setThinkingStatus}
            onSubmit={submitProfile}
            onDemo={startDemo}
            onEcho={() => setActiveView("echo")}
          />
        )}

        {!showAccountAccess && activeView === "game" && state.screen === "matching" && (
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

        {!showAccountAccess && activeView === "game" && state.screen === "queue" && (
          <CapacityQueue
            nickname={state.nickname}
            position={state.queuePosition ?? 1}
            elapsed={queueElapsed}
            hasError={Boolean(state.error)}
            onCancel={cancelMatching}
            onDemo={startDemo}
          />
        )}

        {!showAccountAccess && activeView === "game" && state.screen === "admission" && (
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

        {!showAccountAccess && activeView === "game" && state.screen === "chat" && (
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
            tutorialMode={state.demoMode}
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
          activeView === "game" &&
          state.screen === "finished" &&
          state.result && (
          <ResultScreen
            result={state.result}
            nickname={state.nickname}
            messageCount={state.messages.length}
            tutorialMode={state.demoMode}
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

      {archiveConsentGameId && accountSession && (
        <ArchiveConsentDialog
          csrfToken={accountSession.csrfToken}
          gameId={archiveConsentGameId}
          onClose={() => setArchiveConsentGameId(null)}
        />
      )}

      {logoutOpen && accountSession && (
        <LogoutConfirmDialog
          busy={authBusy}
          onCancel={() => setLogoutOpen(false)}
          onConfirm={() => void handleLogout()}
        />
      )}
    </div>
  );
}

export interface AccountAccessProps {
  mode: AuthMode;
  loading: boolean;
  busy: boolean;
  error: string | null;
  message: string | null;
  hasResetToken: boolean;
  onModeChange: (mode: AuthMode) => void;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string) => Promise<void>;
  onResendVerification: (email: string) => Promise<void>;
  onForgotPassword: (email: string) => Promise<void>;
  onResetPassword: (newPassword: string) => Promise<void>;
  onLocalDemo: () => void;
}

export function AccountAccess({
  mode,
  loading,
  busy,
  error,
  message,
  hasResetToken,
  onModeChange,
  onLogin,
  onRegister,
  onResendVerification,
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
      if (mode === "resend") {
        await onResendVerification(email);
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
      : mode === "resend"
        ? "重新发送验证邮件"
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
                  placeholder="name@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            )}

            {mode !== "forgot" && mode !== "resend" && (
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
                    : mode === "resend"
                      ? "重新发送验证邮件"
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
                <button type="button" onClick={() => switchMode("resend")}>
                  重新发送验证邮件
                </button>
                <button type="button" onClick={() => switchMode("forgot")}>
                  忘记密码
                </button>
              </>
            )}
          </nav>
        )}

        <div className="demo-bypass">
          <span>NO ACCOUNT / GUIDED TOUR</span>
          <button type="button" disabled={busy} onClick={onLocalDemo}>
            进入教学模式 →
          </button>
          <p>
            教学模式不会创建线上会话，由模拟对手陪你走完匹配、聊天和判断流程。
          </p>
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
  tutorialMode: boolean;
  accountIdentity?: string;
  onNicknameChange: (value: string) => void;
  onThinkingStatusChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDemo: () => void;
  onEcho: () => void;
}

export function TutorialCallout({
  step,
  title,
  children,
  compact = false,
}: {
  step: string;
  title: string;
  children: string;
  compact?: boolean;
}) {
  return (
    <aside
      className={`tutorial-callout${compact ? " is-compact" : ""}`}
      role="note"
    >
      <span>教学 {step}</span>
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
      <i aria-hidden="true">↘</i>
    </aside>
  );
}

export function Onboarding({
  nickname,
  thinkingStatus,
  isStarting,
  onlineEnabled,
  tutorialMode,
  accountIdentity,
  onNicknameChange,
  onThinkingStatusChange,
  onSubmit,
  onDemo,
  onEcho,
}: OnboardingProps) {
  return (
    <section className="onboarding page-grid">
      <div className="hero-copy">
        <p className="eyebrow">A FIVE-MINUTE SOCIAL EXPERIMENT</p>
        <h1>
          语言会伪装，
          <br />
          你<span>相信</span>谁？
        </h1>
        <p className="hero-description">
          在一段匿名对话里，停顿、措辞，甚至犹豫都可能成为证词。
          对话结束前，你只有一次机会决定：
          <strong> 另一端，是人，还是 AI。</strong>
        </p>
        <div className="hero-rules" aria-label="游戏规则">
          <span>01 / 匿名相遇</span>
          <span>02 / 20 秒后可判断</span>
          <span>03 / 真相揭晓</span>
        </div>
      </div>

      <form className="identity-panel" onSubmit={onSubmit}>
        <div className="panel-number" aria-hidden="true">
          01
        </div>
        <div className="panel-heading">
          <p>ENTER THE ROOM</p>
          <h2>先为这一局取个名字</h2>
          {accountIdentity && (
            <span className="signed-in-as">{accountIdentity}</span>
          )}
        </div>

        {tutorialMode && (
          <TutorialCallout step="01" title="先起一个本局名字">
            这是只在本局展示的临时名称，不会暴露你的账户名称或邮箱。
          </TutorialCallout>
        )}

        <div className="identity-preview" aria-label="公开身份预览">
          <div>
            <span className="presence-mark" />
            <small>IDENTITY PREVIEW / 07</small>
          </div>
          <strong>{nickname.trim() || "未命名观察者"}</strong>
          <p>{thinkingStatus.trim() || "正在等待一个念头…"}</p>
        </div>

        <label className={`field${tutorialMode ? " tutorial-ring" : ""}`}>
          <span>本局临时名称 / MATCH NAME</span>
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
          <em>只在本局匿名对话中展示，与右上角账户名称分开。</em>
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
            className={`demo-action${tutorialMode ? " tutorial-ring" : ""}`}
            type="button"
            disabled={isStarting}
            onClick={onDemo}
          >
            <span>{tutorialMode ? "开始教学对局" : "教学模式"}</span>
            <small>无需账户 · 分步引导 · 最长 10 分钟</small>
          </button>
        </div>

        <button
          className="echo-entry-action"
          type="button"
          disabled={!onlineEnabled || isStarting}
          onClick={onEcho}
        >
          <span>
            <strong>回声档案</strong>
            <small>
              {onlineEnabled
                ? "作为回声鉴证官，重听一段身份未署名的对话"
                : "登录账户后才可领取匿名档案"}
            </small>
          </span>
          <i aria-hidden="true">02 ↗</i>
        </button>

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
          切换教学模式 <span aria-hidden="true">↗</span>
        </button>
      )}
      <button className="text-action" type="button" onClick={onCancel}>
        ← 返回并取消匹配
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
        <span>{demoMode ? "教学模式通道" : "匿名公共通道"}</span>
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
            <span>另一端的声音</span>
          </h1>
          <p className="search-message" role="status" aria-live="polite">
            {message}
          </p>
          {demoMode && (
            <TutorialCallout step="02" title="先经历完整匹配" compact>
              即使模拟对手已经就位，也会等待至少 5 秒；线上真人匹配遵循同样节奏。
            </TutorialCallout>
          )}
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
          ? "等待对手确认"
          : "锁定对话房间";

  return (
    <section className="matching-screen">
      <div className="matching-meta">
        <span>ROOM CONNECTION</span>
        <span>{demoMode ? "教学模式通道" : "匿名公共通道"}</span>
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
            另一端正在
            <br />
            <span>接入房间</span>
          </h1>
          {demoMode && (
            <TutorialCallout step="03" title="观察统一入场" compact>
              这段固定 5 秒的入场倒计时不会透露对手是真人还是 AI。
            </TutorialCallout>
          )}
        </div>
      </div>
      <div
        className={`calibration${demoMode ? " tutorial-ring tutorial-ring-wide" : ""}`}
      >
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
          {["安全通道", "匿名身份", "对手确认", "房间锁定"].map(
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
  tutorialMode: boolean;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onMessageChange: (value: string) => void;
  onMessageSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onMessageBlur: () => void;
  onMessageKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onGuess: () => void;
  onReport: () => void;
  onLeave: () => void;
}

export function ChatRoom({
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
  tutorialMode,
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
          <h1 className="observation-mantra" aria-label="观察。试探。判断。">
            <span>观察。</span>
            <span>试探。</span>
            <span>判断。</span>
          </h1>
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
            className={`guess-action${tutorialMode ? " is-tutorial tutorial-ring" : ""}`}
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
              {tutorialMode && (
                <small className="tutorial-button-label">
                  教学 06 · 最后在这里判断
                </small>
              )}
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
          <p>身份将在对局结束后揭晓</p>
        </header>

        <div
          className="message-list"
          role="log"
          tabIndex={0}
          aria-live="polite"
          aria-label="对话消息，可上下滚动"
        >
          {gameRemaining > 0 && gameRemaining <= 30_000 && (
            <div className="game-ending-warning" role="status">
              <strong>{formatClock(gameRemaining)} 后结束</strong>
              <span>
                {guessSubmitted
                  ? "判断已锁定，但对话仍然开放。"
                  : "还没有提交判断，请在倒计时结束前完成。"}
              </span>
            </div>
          )}
          {messages.length === 0 && (
            <div className="conversation-empty">
              <span className="empty-index">NO SIGNAL / START WITH A QUESTION</span>
              {tutorialMode && (
                <TutorialCallout step="04" title="点一个问题试试" compact>
                  系统每局会随机抽出 3 道题。点击后会自动填入输入框，你仍可以继续修改。
                </TutorialCallout>
              )}
              <h2>别急着问好。</h2>
              <p>
                问一个需要记忆、偏好或犹豫才能回答的问题。答案重要，迟疑也重要。
              </p>
              <div
                className={`opening-questions${tutorialMode ? " tutorial-ring tutorial-ring-questions" : ""}`}
                aria-label="开场问题建议"
              >
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

        <form
          className={`composer${tutorialMode ? " tutorial-ring tutorial-ring-composer" : ""}`}
          onSubmit={onMessageSubmit}
        >
          <div className="composer-heading">
            <label htmlFor="message">你的消息</label>
            <span className={tutorialMode ? "tutorial-composer-note" : undefined}>
              {tutorialMode && !guessSubmitted
                ? "教学 05 · 写好后点发送 ↘"
                : guessSubmitted
                  ? "VERDICT LOCKED · CHAT OPEN"
                  : "ENCRYPTED CHANNEL"}
            </span>
          </div>
          <textarea
            id="message"
            value={messageDraft}
            maxLength={100}
            rows={2}
            placeholder={
              guessSubmitted
                ? "判断已经锁定，还可以继续对话…"
                : "输入一个问题…"
            }
            onChange={(event) => onMessageChange(event.target.value)}
            onBlur={onMessageBlur}
            onKeyDown={onMessageKeyDown}
          />
          <div className="composer-footer">
            <span>{messageDraft.length}/100 · ENTER 发送 / SHIFT+ENTER 换行</span>
            <button
              type="submit"
              disabled={!messageDraft.trim()}
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
        <h2 id="guess-title">现在，你相信哪一种答案？</h2>
        <p className="modal-lead">
          这是本局唯一一次判断。提交后无法修改，对话也会立即冻结。
        </p>
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

export function LogoutConfirmDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEscapeToClose(busy ? () => undefined : onCancel);
  return (
    <div className="modal-backdrop" role="presentation">
      <dialog
        className="modal confirm-modal"
        open
        aria-modal="true"
        aria-labelledby="logout-title"
      >
        <p className="eyebrow">SIGN OUT / ACCOUNT</p>
        <h2 id="logout-title">确定退出当前账号？</h2>
        <p className="modal-lead">
          退出后需要重新登录，正在进行的匹配或对局也会结束。
        </p>
        <div className="modal-actions">
          <button
            className="danger-action"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "正在退出…" : "退出当前账号"}
          </button>
          <button
            autoFocus
            className="text-action"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            继续留在这里
          </button>
        </div>
      </dialog>
    </div>
  );
}

export function AccountRecordPage({
  record,
  accountUser,
  echoEnabled,
  onBack,
  onEchoRecords,
  onSaveDisplayName,
  onChangePassword,
  onCreator,
  onSupport,
  onFeedback,
}: {
  record: LocalPlayerRecord;
  accountUser?: AccountSessionResponse["user"];
  echoEnabled: boolean;
  onBack: () => void;
  onEchoRecords: () => void;
  onSaveDisplayName: (displayName: string) => Promise<void>;
  onChangePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  onCreator: () => void;
  onSupport: () => void;
  onFeedback: () => void;
}) {
  const [displayName, setDisplayName] = useState(
    accountUser?.displayName ?? "",
  );
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameMessage, setNameMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setDisplayName(accountUser?.displayName ?? "");
  }, [accountUser?.displayName]);

  async function submitDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = displayName.trim();
    if (!accountUser || nameBusy || nextName.length < 2) return;
    setNameBusy(true);
    setNameError(null);
    setNameMessage(null);
    try {
      await onSaveDisplayName(nextName);
      setDisplayName(nextName);
      setNameMessage("全局名称已经保存好啦 ( •̀ ω •́ )✧");
    } catch (error) {
      setNameError(
        error instanceof Error
          ? error.message
          : "名称没有保存成功，请稍后重试。",
      );
    } finally {
      setNameBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordBusy) return;
    if (newPassword !== passwordConfirmation) {
      setPasswordMessage(null);
      setPasswordError("两次输入的新密码不一致。");
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    setPasswordMessage(null);
    try {
      await onChangePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setPasswordMessage(
        "密码修改成功啦，其他设备的登录会话已经退出 ( •̀ ω •́ )✧",
      );
    } catch (error) {
      setPasswordError(
        error instanceof Error
          ? error.message
          : "密码没有修改成功，请稍后重试。",
      );
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <section className="record-page">
      <div className="record-page-heading">
        <button className="record-back" type="button" onClick={onBack}>
          ← 返回实验
        </button>
        <div>
          <p>PLAYER FILE / ACCOUNT DATA</p>
          <h1>账户数据</h1>
          <span>
            {accountUser
              ? `${accountUser.displayName} · NO. ${accountUser.playerNumber}`
              : "教学模式身份"}
          </span>
        </div>
        <p>你的 1v1 对局与回声鉴证记录。</p>
      </div>

      <nav className="record-mode-switcher" aria-label="战绩模式">
        <button className="is-active" type="button" aria-current="page">
          <strong>1v1 对局</strong>
          <span>本机判断记录</span>
        </button>
        <button
          type="button"
          disabled={!echoEnabled}
          onClick={onEchoRecords}
        >
          <strong>回声档案</strong>
          <span>{echoEnabled ? "云端鉴证记录" : "登录后查看"}</span>
          <i aria-hidden="true">↗</i>
        </button>
      </nav>

      <div className="record-overview">
        {accountUser ? (
          <>
            <form
              className="account-identity-card"
              onSubmit={(event) => void submitDisplayName(event)}
            >
              <div>
                <span>GLOBAL IDENTITY / ACCOUNT</span>
                <strong>NO. {accountUser.playerNumber}</strong>
              </div>
              <label>
                <span>全局账户名称</span>
                <input
                  type="text"
                  value={displayName}
                  minLength={2}
                  maxLength={18}
                  autoComplete="nickname"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <button
                className="text-action"
                type="submit"
                disabled={
                  nameBusy ||
                  displayName.trim().length < 2 ||
                  displayName.trim() === accountUser.displayName
                }
              >
                {nameBusy ? "保存中…" : "保存账户名称 →"}
              </button>
              <p>
                这个名称显示在你的账户页和右上角；1v1 中仍使用每局单独填写的
                临时名称。
              </p>
              {nameError && (
                <p className="field-error" role="alert">{nameError}</p>
              )}
              {nameMessage && (
                <p className="form-message" role="status">{nameMessage}</p>
              )}
            </form>

            <form
              className="account-security-card"
              onSubmit={(event) => void submitPasswordChange(event)}
            >
              <div>
                <span>ACCOUNT SECURITY</span>
                <h2>修改账号密码</h2>
                <p>修改后保留当前设备，其他设备会自动退出登录。</p>
              </div>
              <label>
                <span>当前密码</span>
                <input
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
              <label>
                <span>新密码</span>
                <input
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label>
                <span>再次输入新密码</span>
                <input
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete="new-password"
                  value={passwordConfirmation}
                  onChange={(event) =>
                    setPasswordConfirmation(event.target.value)
                  }
                />
              </label>
              <button
                className="text-action"
                type="submit"
                disabled={
                  passwordBusy ||
                  currentPassword.length < 12 ||
                  newPassword.length < 12 ||
                  passwordConfirmation.length < 12
                }
              >
                {passwordBusy ? "修改中…" : "确认修改密码 →"}
              </button>
              {passwordError && (
                <p className="field-error" role="alert">{passwordError}</p>
              )}
              {passwordMessage && (
                <p className="form-message" role="status">{passwordMessage}</p>
              )}
            </form>
          </>
        ) : (
          <div className="account-identity-card is-local">
            <span>LOCAL IDENTITY / NO CLOUD PROFILE</span>
            <strong>教学模式</strong>
            <p>登录后即可领取稳定玩家编号并设置全局账户名称。</p>
          </div>
        )}
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

export function CreatorDialog({ onClose }: { onClose: () => void }) {
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
        <p className="creator-kicker">FOLLOW THE CREATOR / 04</p>
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
          <a
            className="creator-platform is-github"
            href={GITHUB_PROJECT_URL}
            target="_blank"
            rel="noreferrer"
          >
            <span>GITHUB / OPEN SOURCE</span>
            <strong>去 GitHub 看看项目</strong>
            <i aria-hidden="true">↗</i>
          </a>
          <article
            className="creator-platform is-business"
            aria-label="商务合作微信"
          >
            <span>WECHAT / BUSINESS</span>
            <strong>商务合作</strong>
            <small>
              微信 W210548735
              <br />
              添加时请备注来意
            </small>
            <i aria-hidden="true">＋</i>
          </article>
        </div>
        <button className="support-close-action" type="button" onClick={onClose}>
          好哒，晚点去逛
        </button>
      </dialog>
    </div>
  );
}

export function FeedbackDialog({
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
            <fieldset disabled={busy}>
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
                当前是教学模式身份，可以先写完；提交时登录账户，就能安全送到作者邮箱喵。
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

const RESULT_STYLE_OPTIONS = [
  {
    id: "signal",
    index: "01",
    label: "信号档案",
    description: "实验网格与荧光信号",
  },
  {
    id: "noir",
    index: "02",
    label: "黑箱判决",
    description: "深色高反差揭晓",
  },
  {
    id: "split",
    index: "03",
    label: "双向证词",
    description: "判断与身份并置",
  },
] as const;

type ResultStyle = (typeof RESULT_STYLE_OPTIONS)[number]["id"];

export function ResultScreen({
  result,
  nickname,
  messageCount,
  tutorialMode,
  onAgain,
  onHome,
}: {
  result: GameResult;
  nickname: string;
  messageCount: number;
  tutorialMode: boolean;
  onAgain: () => void;
  onHome: () => void;
}) {
  const [resultStyle, setResultStyle] = useState<ResultStyle>(
    () =>
      RESULT_STYLE_OPTIONS[
        Math.floor(Math.random() * RESULT_STYLE_OPTIONS.length)
      ].id,
  );
  const [shareStatus, setShareStatus] = useState<
    "idle" | "downloaded" | "copied" | "failed"
  >("idle");
  const actualIdentity = result.opponentType === "human" ? "真人" : "AI";
  const playerGuess =
    result.guess === null ? "未提交" : result.guess === "human" ? "真人" : "AI";
  const finalMessageCount = result.stats?.messageCount ?? messageCount;
  const finalScore =
    result.stats?.scoreDelta ?? (result.isCorrect ? 12 : 0);
  const finalStreak = result.stats?.streak ?? (result.isCorrect ? 1 : 0);
  const shareText = [
    `我在 TURING? 中判断${result.isCorrect ? "正确" : "失误"}。`,
    `屏幕另一边是${actualIdentity}，我的判断是${playerGuess}。`,
    `${finalMessageCount} 条消息 · ${finalScore >= 0 ? "+" : ""}${finalScore} 分 · ${finalStreak} 连胜`,
    "当语言会伪装，你还相信自己的判断吗？",
  ].join("\n");

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(shareText);
      setShareStatus("copied");
    } catch {
      setShareStatus("failed");
    }
  }

  async function downloadResultCard() {
    try {
      await document.fonts?.ready;
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 630;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas is unavailable");
      }

      const palette =
        resultStyle === "noir"
          ? {
              background: "#10110f",
              surface: "#171915",
              ink: "#fafaf5",
              muted: "#aeb1a7",
              accent: result.isCorrect ? "#b8ff28" : "#ff7a70",
            }
          : resultStyle === "split"
            ? {
                background: "#ebe9df",
                surface: "#fafaf5",
                ink: "#10110f",
                muted: "#6a6c64",
                accent: result.isCorrect ? "#b8ff28" : "#ff7a70",
              }
            : {
                background: "#f2f2ed",
                surface: "#fafaf5",
                ink: "#10110f",
                muted: "#6a6c64",
                accent: result.isCorrect ? "#b8ff28" : "#ff7a70",
              };

      context.fillStyle = palette.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (resultStyle === "split") {
        context.fillStyle = palette.surface;
        context.fillRect(680, 28, 492, 574);
      }

      context.strokeStyle =
        resultStyle === "noir"
          ? "rgba(250, 250, 245, 0.09)"
          : "rgba(16, 17, 15, 0.08)";
      context.lineWidth = 1;
      [300, 600, 900].forEach((x) => {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, canvas.height);
        context.stroke();
      });

      context.beginPath();
      context.arc(1015, 154, 210, 0, Math.PI * 2);
      context.fillStyle = palette.accent;
      context.fill();

      context.strokeStyle = palette.ink;
      context.lineWidth = 3;
      context.strokeRect(28, 28, 1144, 574);

      context.fillStyle = palette.ink;
      context.textBaseline = "top";
      context.font =
        '800 30px "Space Grotesk", "Noto Sans SC", "Microsoft YaHei", sans-serif';
      context.fillText("TURING?", 64, 58);

      context.fillStyle = palette.muted;
      context.font =
        '700 16px "Space Grotesk", "Noto Sans SC", "Microsoft YaHei", sans-serif';
      context.fillText("IDENTITY REVEALED / RESULT VERIFIED", 64, 112);

      context.fillStyle = palette.ink;
      context.font =
        '900 172px "Noto Sans SC", "Microsoft YaHei", sans-serif';
      context.fillText(actualIdentity, 56, 146);

      context.font =
        '800 42px "Noto Sans SC", "Microsoft YaHei", sans-serif';
      context.fillText(result.isCorrect ? "判断正确" : "判断失误", 720, 238);

      context.fillStyle = palette.muted;
      context.font =
        '600 22px "Noto Sans SC", "Microsoft YaHei", sans-serif';
      context.fillText(`你的判断：${playerGuess}`, 724, 304);

      const statTop = 438;
      const statWidth = 320;
      const stats = [
        ["对话消息", String(finalMessageCount)],
        ["本局得分", `${finalScore >= 0 ? "+" : ""}${finalScore}`],
        ["当前连胜", String(finalStreak)],
      ];
      stats.forEach(([label, value], index) => {
        const x = 64 + index * statWidth;
        context.strokeStyle = palette.ink;
        context.lineWidth = 1;
        context.strokeRect(x, statTop, statWidth, 108);
        context.fillStyle = palette.muted;
        context.font =
          '700 14px "Noto Sans SC", "Microsoft YaHei", sans-serif';
        context.fillText(label, x + 18, statTop + 16);
        context.fillStyle = palette.ink;
        context.font =
          '800 34px "Space Grotesk", "Noto Sans SC", "Microsoft YaHei", sans-serif';
        context.fillText(value, x + 18, statTop + 48);
      });

      context.fillStyle = palette.muted;
      context.font =
        '700 14px "Space Grotesk", "Noto Sans SC", "Microsoft YaHei", sans-serif';
      context.fillText(
        "CAN YOU TELL WHO IS ON THE OTHER SIDE?",
        64,
        566,
      );
      context.textAlign = "right";
      context.fillText("EXP. / 001", 1138, 566);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) resolve(value);
          else reject(new Error("Unable to encode result card"));
        }, "image/png");
      });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `turing-result-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      setShareStatus("downloaded");
    } catch {
      setShareStatus("failed");
    }
  }

  return (
    <section className={`result-screen ${result.isCorrect ? "is-win" : "is-loss"}`}>
      <div className="result-kicker">
        <span>IDENTITY REVEALED</span>
        <span>{result.isCorrect ? "判断成立" : "判断偏差"}</span>
      </div>
      {tutorialMode && (
        <TutorialCallout step="07" title="教学完成" compact>
          身份与得分都会在这里揭晓。你可以再来一局练习，或返回首页开始真人匹配。
        </TutorialCallout>
      )}
      <aside className="result-style-switcher" aria-label="结算卡风格">
        <span>RESULT STYLE</span>
        {RESULT_STYLE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={resultStyle === option.id ? "is-active" : ""}
            aria-pressed={resultStyle === option.id}
            onClick={() => setResultStyle(option.id)}
          >
            <i>{option.index}</i>
            <strong>{option.label}</strong>
            <small>{option.description}</small>
          </button>
        ))}
      </aside>
      <div
        className={`result-card style-${resultStyle}`}
        aria-label="本局结果战绩卡"
      >
        <div className="result-card-signal" aria-hidden="true">
          RESULT / VERIFIED
        </div>
        <div className="result-identity">
          <p className="result-step">02 / 真实身份</p>
          <p>屏幕另一边是</p>
          <h1>{actualIdentity}</h1>
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
            <strong>{playerGuess}</strong>
            <span>
              {result.isCorrect
                ? "这一次，你读懂了另一端。"
                : "这一次，语言替对方藏住了身份。"}
            </span>
          </div>
        </div>
        <dl className="result-stats">
          <div>
            <dt>对话消息</dt>
            <dd>{finalMessageCount}</dd>
          </div>
          <div>
            <dt>本局得分</dt>
            <dd>
              {finalScore >= 0 ? "+" : ""}
              {finalScore}
            </dd>
          </div>
          <div>
            <dt>当前连胜</dt>
            <dd>{finalStreak}</dd>
          </div>
        </dl>
        <div className="result-card-footer">
          <strong>TURING?</strong>
          <span>CAN YOU TELL WHO IS ON THE OTHER SIDE?</span>
          <i aria-hidden="true">EXP. / 001</i>
        </div>
      </div>
      <div className="result-actions">
        <button className="primary-action" type="button" onClick={onAgain}>
          再来一局 <span aria-hidden="true">↗</span>
        </button>
        <button
          className="share-action"
          type="button"
          onClick={() => void downloadResultCard()}
        >
          下载结果卡 <span aria-hidden="true">↓</span>
        </button>
        <button
          className="text-action"
          type="button"
          onClick={() => void copyResult()}
        >
          复制结果
        </button>
        <button className="text-action" type="button" onClick={onHome}>
          ← 返回首页
        </button>
        <span className="share-status" role="status" aria-live="polite">
          {shareStatus === "copied" && "结果已复制"}
          {shareStatus === "downloaded" && "结果卡已下载"}
          {shareStatus === "failed" && "暂时无法生成结果卡，请稍后重试"}
        </span>
      </div>
    </section>
  );
}
