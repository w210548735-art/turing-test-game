import {
  accountSessionResponseSchema,
  forgotPasswordRequestSchema,
  forgotPasswordResponseSchema,
  loginAccountRequestSchema,
  logoutResponseSchema,
  parseServerEvent,
  profileInputSchema,
  registerAccountRequestSchema,
  registerAccountResponseSchema,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
  submitFeedbackRequestSchema,
  submitFeedbackResponseSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
  type AccountSessionResponse,
  type ClientEvent,
  type ForgotPasswordRequest,
  type FeedbackCategory,
  type Identity,
  type LoginAccountRequest,
  type ProfileInput,
  type RegisterAccountRequest,
  type ResetPasswordRequest,
  type ServerEvent,
  type SubmitFeedbackRequest,
  type VerifyEmailRequest,
} from "@turing-game/protocol";

export type {
  AccountSessionResponse,
  ClientEvent,
  FeedbackCategory,
  ProfileInput,
  ServerEvent,
};

export interface GameTransport {
  connect(): Promise<void>;
  send(event: ClientEvent): void;
  close(): void;
}

interface TransportCallbacks {
  onEvent: (event: ServerEvent) => void;
  onConnectionChange: (
    state: "connecting" | "connected" | "disconnected",
  ) => void;
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

interface InputValidationIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
}

type InputValidationResult<T> =
  | {
      readonly success: true;
      readonly data: T;
    }
  | {
      readonly success: false;
      readonly error: {
        readonly issues: readonly InputValidationIssue[];
      };
    };

function inputValidationMessage(
  issues: readonly InputValidationIssue[],
  invalidTokenMessage = "链接无效或已过期。",
): string {
  const issue = issues[0];
  const field = String(issue?.path[0] ?? "");

  if (field === "email") {
    return "请输入有效的邮箱地址。";
  }
  if (field === "password" || field === "newPassword") {
    if (issue?.code === "too_small") {
      return "密码至少需要 12 个字符。";
    }
    if (issue?.code === "too_big") {
      return "密码最多允许 128 个字符。";
    }
    return "密码格式不正确。";
  }
  if (field === "token") {
    return invalidTokenMessage;
  }
  return "提交内容格式不正确，请检查后重试。";
}

function parseAccountInput<T>(
  result: InputValidationResult<T>,
  invalidTokenMessage?: string,
): T {
  if (result.success) {
    return result.data;
  }
  throw new Error(
    inputValidationMessage(result.error.issues, invalidTokenMessage),
  );
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: string;
      error?: string | { message?: string };
    };
    return (
      body.message ??
      (typeof body.error === "string" ? body.error : body.error?.message) ??
      `请求失败（${response.status}）`
    );
  } catch {
    return `请求失败（${response.status}）`;
  }
}

async function postJson(
  path: string,
  body?: unknown,
  csrfToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function registerAccount(
  input: RegisterAccountRequest,
): Promise<ReturnType<typeof registerAccountResponseSchema.parse>> {
  const validatedInput = parseAccountInput(
    registerAccountRequestSchema.safeParse(input),
  );
  const response = await postJson(
    "/api/auth/register",
    validatedInput,
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return registerAccountResponseSchema.parse(await response.json());
}

export async function verifyAccountEmail(
  input: VerifyEmailRequest,
): Promise<ReturnType<typeof verifyEmailResponseSchema.parse>> {
  const validatedInput = parseAccountInput(
    verifyEmailRequestSchema.safeParse(input),
    "验证链接无效或已过期。",
  );
  const response = await postJson(
    "/api/auth/verify-email",
    validatedInput,
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return verifyEmailResponseSchema.parse(await response.json());
}

export async function loginAccount(
  input: LoginAccountRequest,
): Promise<AccountSessionResponse> {
  const validatedInput = parseAccountInput(
    loginAccountRequestSchema.safeParse(input),
  );
  const response = await postJson(
    "/api/auth/login",
    validatedInput,
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return accountSessionResponseSchema.parse(await response.json());
}

export async function bootstrapAccount(): Promise<AccountSessionResponse | null> {
  const response = await postJson("/api/auth/bootstrap");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return accountSessionResponseSchema.parse(await response.json());
}

export async function forgotAccountPassword(
  input: ForgotPasswordRequest,
): Promise<ReturnType<typeof forgotPasswordResponseSchema.parse>> {
  const validatedInput = parseAccountInput(
    forgotPasswordRequestSchema.safeParse(input),
  );
  const response = await postJson(
    "/api/auth/password/forgot",
    validatedInput,
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return forgotPasswordResponseSchema.parse(await response.json());
}

export async function resetAccountPassword(
  input: ResetPasswordRequest,
): Promise<ReturnType<typeof resetPasswordResponseSchema.parse>> {
  const validatedInput = parseAccountInput(
    resetPasswordRequestSchema.safeParse(input),
    "重置密码链接无效或已过期。",
  );
  const response = await postJson(
    "/api/auth/password/reset",
    validatedInput,
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return resetPasswordResponseSchema.parse(await response.json());
}

export async function logoutAccount(
  csrfToken: string,
): Promise<ReturnType<typeof logoutResponseSchema.parse>> {
  const response = await postJson("/api/auth/logout", undefined, csrfToken);
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return logoutResponseSchema.parse(await response.json());
}

export async function submitAccountFeedback(
  csrfToken: string,
  input: SubmitFeedbackRequest,
): Promise<ReturnType<typeof submitFeedbackResponseSchema.parse>> {
  const validatedInput = parseAccountInput(
    submitFeedbackRequestSchema.safeParse(input),
  );
  const response = await postJson(
    "/api/feedback",
    validatedInput,
    csrfToken,
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return submitFeedbackResponseSchema.parse(await response.json());
}

export async function saveProfile(
  csrfToken: string,
  profile: ProfileInput,
): Promise<void> {
  const validatedProfile = profileInputSchema.parse(profile);
  const response = await fetch(`${API_BASE}/api/profile`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(validatedProfile),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

async function requestWsTicket(csrfToken: string): Promise<string> {
  const response = await fetch(`${API_BASE}/api/ws-ticket`, {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  const body = (await response.json()) as { wsTicket?: unknown };
  if (typeof body.wsTicket !== "string" || body.wsTicket.length < 20) {
    throw new Error("服务器未返回有效的实时连接票据。");
  }
  return body.wsTicket;
}

function createWsUrl(ticket: string): string {
  if (import.meta.env.VITE_WS_URL) {
    const explicit = String(import.meta.env.VITE_WS_URL).replace(/\/$/, "");
    return `${explicit}/ws?ticket=${encodeURIComponent(ticket)}`;
  }
  if (API_BASE) {
    const url = new URL(API_BASE, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
    url.search = `ticket=${encodeURIComponent(ticket)}`;
    return url.toString();
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export class OnlineTransport implements GameTransport {
  private socket: WebSocket | null = null;
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private lastSequence = 0;

  constructor(
    private readonly csrfToken: string,
    private readonly callbacks: TransportCallbacks,
    private initialWsTicket?: string,
  ) {}

  async connect(): Promise<void> {
    this.manuallyClosed = false;
    this.callbacks.onConnectionChange("connecting");
    const ticket =
      this.initialWsTicket ?? (await requestWsTicket(this.csrfToken));
    this.initialWsTicket = undefined;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(createWsUrl(ticket));
      this.socket = socket;
      let settled = false;

      socket.addEventListener("open", () => {
        const isReconnect = this.reconnectAttempts > 0;
        this.reconnectAttempts = 0;
        this.callbacks.onConnectionChange("connected");
        if (isReconnect) {
          socket.send(
            JSON.stringify({
              type: "game.resume",
              lastSequence: this.lastSequence,
            } satisfies ClientEvent),
          );
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener("message", (message) => {
        try {
          const event = parseServerEvent(JSON.parse(message.data));
          if (event.type === "chat.message") {
            this.lastSequence = Math.max(
              this.lastSequence,
              event.sequence,
            );
          } else if (event.type === "game.snapshot") {
            this.lastSequence = Math.max(
              this.lastSequence,
              event.lastSequence,
            );
          }
          this.callbacks.onEvent(event);
        } catch {
          this.callbacks.onEvent({
            type: "game.error",
            message: "收到无法解析的服务器消息。",
          });
        }
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("无法建立实时连接。"));
        }
      });

      socket.addEventListener("close", () => {
        this.callbacks.onConnectionChange("disconnected");
        if (!settled) {
          settled = true;
          reject(new Error("实时连接在建立前关闭。"));
        }
        this.scheduleReconnect();
      });
    });
  }

  send(event: ClientEvent): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("实时连接尚未就绪，请稍后重试。");
    }
    this.socket.send(JSON.stringify(event));
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }
    this.socket?.close(1000, "client_closed");
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectAttempts >= 3) {
      return;
    }
    const delay = 800 * 2 ** this.reconnectAttempts;
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      void this.connect().catch(() => undefined);
    }, delay);
  }
}

const DEMO_REPLIES = [
  "你先问这个，是想观察我的反应速度，还是答案本身？",
  "有时停顿是因为在想，有时只是因为不知道怎么说得自然。",
  "如果只能选一个，我会选雨后的城市。它闻起来像系统刚刚重启。",
  "这问题太像陷阱了。不过真人也会故意把答案说得像模型，对吧？",
  "我更好奇：你现在已经有答案了，还是还在收集证据？",
];

export class DemoTransport implements GameTransport {
  private timers = new Set<number>();
  private sequence = 0;
  private replyIndex = 0;
  private opponentType: Identity = Math.random() < 0.25 ? "ai" : "human";

  constructor(private readonly callbacks: TransportCallbacks) {}

  async connect(): Promise<void> {
    this.callbacks.onConnectionChange("connecting");
    await new Promise<void>((resolve) => {
      this.later(() => {
        this.callbacks.onConnectionChange("connected");
        resolve();
      }, 180);
    });
  }

  send(event: ClientEvent): void {
    switch (event.type) {
      case "match.join":
        this.beginMatch();
        break;
      case "match.cancel":
        this.clearTimers();
        break;
      case "chat.send":
        this.receiveOwnMessage(event.content, event.clientMessageId);
        this.simulateReply();
        break;
      case "guess.submit":
        this.callbacks.onEvent({
          type: "guess.accepted",
          targetGuess: event.targetGuess,
        });
        this.later(() => {
          const isCorrect = event.targetGuess === this.opponentType;
          this.callbacks.onEvent({
            type: "game.finished",
            opponentType: this.opponentType,
            guess: event.targetGuess,
            isCorrect,
            outcome: isCorrect ? "won" : "lost",
            archiveConsentEligible: false,
            stats: {
              durationSeconds: 20,
              messageCount: this.sequence,
              streak: isCorrect ? 1 : 0,
              scoreDelta: isCorrect ? 12 : 0,
            },
          });
        }, 850);
        break;
      case "game.report":
        this.later(
          () => this.callbacks.onEvent({ type: "game.reported" }),
          280,
        );
        break;
      case "game.leave":
        this.callbacks.onEvent({
          type: "game.disconnected",
          message: "你已离开本局。",
        });
        break;
      case "chat.typing_start":
      case "chat.typing_stop":
        break;
    }
  }

  close(): void {
    this.clearTimers();
    this.callbacks.onConnectionChange("disconnected");
  }

  private beginMatch(): void {
    this.clearTimers();
    this.sequence = 0;
    this.replyIndex = 0;
    this.opponentType = Math.random() < 0.25 ? "ai" : "human";
    this.callbacks.onEvent({
      type: "match.searching",
      searchStartedAt: Date.now(),
    });

    for (let step = 1; step <= 10; step += 1) {
      this.later(() => {
        this.callbacks.onEvent({
          type: "match.progress",
          progress: step / 10,
        });
      }, 5_000 + step * 500);
    }

    this.later(() => {
      this.callbacks.onEvent({
        type: "match.admission",
        gateEndsAt: Date.now() + 5_000,
      });
    }, 5_000);

    this.later(() => {
      const startedAt = Date.now();
      this.callbacks.onEvent({
        type: "match.found",
        gameId: `demo-${startedAt}`,
        startedAt,
        endsAt: startedAt + 5 * 60_000,
        minGuessAt: startedAt + 20_000,
        opponentLabel: "匿名玩家 / 07",
      });
    }, 10_000);
  }

  private receiveOwnMessage(content: string, id: string): void {
    this.sequence += 1;
    this.callbacks.onEvent({
      type: "chat.message",
      id,
      sender: "self",
      content,
      sequence: this.sequence,
      createdAt: Date.now(),
    });
  }

  private simulateReply(): void {
    this.later(
      () => this.callbacks.onEvent({ type: "chat.typing_start" }),
      420,
    );
    this.later(() => {
      this.sequence += 1;
      this.callbacks.onEvent({ type: "chat.typing_stop" });
      this.callbacks.onEvent({
        type: "chat.message",
        id: `demo-reply-${this.sequence}`,
        sender: "opponent",
        content: DEMO_REPLIES[this.replyIndex % DEMO_REPLIES.length],
        sequence: this.sequence,
        createdAt: Date.now(),
      });
      this.replyIndex += 1;
    }, 1_700);
  }

  private later(callback: () => void, delay: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers.clear();
  }
}
