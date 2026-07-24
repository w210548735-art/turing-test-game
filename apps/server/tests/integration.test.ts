import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildServer, type ServerContext } from "../src/server.js";

interface EventMessage {
  type: string;
  [key: string]: unknown;
}

interface SessionContract {
  csrfToken: string;
  userId: string;
  wsTicket: string;
  [key: string]: unknown;
}

interface SessionAuthContext {
  cookieHeader: string;
  csrfToken: string;
  session: SessionContract;
}

const TEST_ORIGIN = "http://localhost:5173";

function extractCookiePair(response: Response, cookieName: string): string {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookieValues =
    headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const cookiePattern = new RegExp(
    `(?:^|,\\s*)${cookieName}=([^;,]+)`,
  );

  for (const setCookieValue of setCookieValues) {
    const match = cookiePattern.exec(setCookieValue);
    if (match?.[1]) {
      return `${cookieName}=${match[1]}`;
    }
  }

  assert.fail(`响应缺少 ${cookieName} Cookie`);
}

async function createSession(baseUrl: string): Promise<SessionAuthContext> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: {
      origin: TEST_ORIGIN,
    },
  });
  assert.equal(response.status, 201);

  const session = (await response.json()) as SessionContract;
  assert.equal(typeof session.userId, "string");
  assert.equal(typeof session.csrfToken, "string");
  assert.equal(typeof session.wsTicket, "string");
  assert.equal("token" in session, false, "会话响应不得泄露长期 token");

  const sessionCookie = extractCookiePair(response, "dev-session");
  const deviceCookie = extractCookiePair(response, "dev-device");
  return {
    cookieHeader: `${sessionCookie}; ${deviceCookie}`,
    csrfToken: session.csrfToken,
    session,
  };
}

class SocketProbe {
  readonly events: EventMessage[] = [];
  private readonly waiters = new Set<{
    type: string;
    resolve: (event: EventMessage) => void;
  }>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as EventMessage;
      this.events.push(event);
      for (const waiter of this.waiters) {
        if (waiter.type === event.type) {
          this.waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    });
  }

  send(event: EventMessage): void {
    this.socket.send(JSON.stringify(event));
  }

  waitFor(type: string, timeoutMs = 8_000): Promise<EventMessage> {
    const existing = this.events.find((event) => event.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`等待 ${type} 超时`));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = (event) => {
        clearTimeout(timer);
        originalResolve(event);
      };
    });
  }
}

describe("HTTP 与 WebSocket 联调协议", () => {
  let context: ServerContext;
  let baseUrl: string;
  let authForNegativeChecks: SessionAuthContext | undefined;
  const openSockets: WebSocket[] = [];

  before(async () => {
    process.env.LOG_LEVEL = "silent";
    process.env.NODE_ENV = "development";
    process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
    context = await buildServer();
    baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  });

  after(async () => {
    openSockets.forEach((socket) => socket.terminate());
    await context.app.close();
  });

  it("十个游客并发完成五秒真人入场、互发消息且票据不可重放", async () => {
    const createPlayer = async (nickname: string) => {
      const auth = await createSession(baseUrl);
      const profileResponse = await fetch(`${baseUrl}/api/profile`, {
        method: "PUT",
        headers: {
          cookie: auth.cookieHeader,
          "content-type": "application/json",
          origin: TEST_ORIGIN,
          "x-csrf-token": auth.csrfToken,
        },
        body: JSON.stringify({
          nickname,
          typingStatus: "正在验证假设…",
        }),
      });
      assert.equal(profileResponse.status, 200);
      const wsUrl = baseUrl.replace(/^http/, "ws");
      const socket = new WebSocket(
        `${wsUrl}/ws?ticket=${encodeURIComponent(auth.session.wsTicket)}`,
        { origin: TEST_ORIGIN },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      openSockets.push(socket);
      return { auth, probe: new SocketProbe(socket) };
    };

    const players = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createPlayer(`观测者${String.fromCharCode(65 + index)}`),
      ),
    );
    const [firstPlayer, secondPlayer] = players;
    assert.ok(firstPlayer && secondPlayer);
    authForNegativeChecks = firstPlayer.auth;
    const first = firstPlayer.probe;
    const second = secondPlayer.probe;
    const joinedAt = Date.now();
    players.forEach(({ probe }) => probe.send({ type: "match.join" }));

    const queuedEvents = await Promise.all(
      players.map(({ probe }) => probe.waitFor("match.queued")),
    );
    const [firstQueued, secondQueued] = queuedEvents;
    assert.ok(firstQueued && secondQueued);
    assert.ok(Number(firstQueued.gateEndsAt) >= joinedAt + 4_900);
    assert.ok(Number(secondQueued.gateEndsAt) >= joinedAt + 4_900);

    await Promise.all(
      players.map(({ probe }) => probe.waitFor("match.found")),
    );
    assert.ok(Date.now() - joinedAt >= 4_900);

    first.send({
      type: "chat.send",
      content: "你觉得什么最容易暴露身份？",
      clientMessageId: "integration-message-1",
    });
    const [ownMessage, peerMessage] = await Promise.all([
      first.waitFor("chat.message"),
      second.waitFor("chat.message"),
    ]);
    assert.equal(ownMessage.sender, "self");
    assert.equal(peerMessage.sender, "opponent");
    assert.equal(peerMessage.content, "你觉得什么最容易暴露身份?");

    first.send({
      type: "game.report",
      reason: "harassment",
      details: "联调举报证据",
    });
    const reported = await first.waitFor("game.reported");
    assert.equal(typeof reported.reportId, "string");

    const wsUrl = baseUrl.replace(/^http/, "ws");
    const replayStatus = await new Promise<number>((resolve, reject) => {
      const replay = new WebSocket(
        `${wsUrl}/ws?ticket=${encodeURIComponent(firstPlayer.auth.session.wsTicket)}`,
        { origin: TEST_ORIGIN },
      );
      replay.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      replay.once("open", () => {
        replay.close();
        reject(new Error("已消费的 WebSocket ticket 被重复接受"));
      });
      replay.once("error", () => undefined);
    });
    assert.equal(replayStatus, 401);

    const replacementTicketResponse = await fetch(
      `${baseUrl}/api/ws-ticket`,
      {
        method: "POST",
        headers: {
          cookie: firstPlayer.auth.cookieHeader,
          origin: TEST_ORIGIN,
          "x-csrf-token": firstPlayer.auth.csrfToken,
        },
      },
    );
    assert.equal(replacementTicketResponse.status, 200);
    const replacementTicket = (await replacementTicketResponse.json()) as {
      wsTicket: string;
    };
    const replacementSocket = new WebSocket(
      `${wsUrl}/ws?ticket=${encodeURIComponent(replacementTicket.wsTicket)}`,
      { origin: TEST_ORIGIN },
    );
    const replacementProbe = new SocketProbe(replacementSocket);
    await new Promise<void>((resolve, reject) => {
      replacementSocket.once("open", resolve);
      replacementSocket.once("error", reject);
    });
    openSockets.push(replacementSocket);
    await replacementProbe.waitFor("game.reconnected");
    replacementProbe.send({ type: "game.resume", lastSequence: 0 });
    const snapshot = await replacementProbe.waitFor("game.snapshot");
    assert.ok(Array.isArray(snapshot.messages));
    assert.ok((snapshot.messages as unknown[]).length >= 1);

    players.forEach(({ probe }) => probe.socket.close());
    replacementSocket.close();
  });

  it("拒绝缺失 Origin、缺失 CSRF 与重复会话 Cookie 的修改请求", async () => {
    const missingOriginResponse = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
    });
    assert.equal(missingOriginResponse.status, 403);

    const auth = authForNegativeChecks;
    assert.ok(auth);
    const missingCsrfResponse = await fetch(`${baseUrl}/api/profile`, {
      method: "PUT",
      headers: {
        cookie: auth.cookieHeader,
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({
        nickname: "缺少 CSRF",
        typingStatus: "测试中",
      }),
    });
    assert.equal(missingCsrfResponse.status, 403);

    const sessionCookie = auth.cookieHeader
      .split("; ")
      .find((cookie) => cookie.startsWith("dev-session="));
    assert.ok(sessionCookie);
    const duplicateCookieResponse = await fetch(`${baseUrl}/api/profile`, {
      method: "PUT",
      headers: {
        cookie: `${auth.cookieHeader}; ${sessionCookie}`,
        "content-type": "application/json",
        origin: TEST_ORIGIN,
        "x-csrf-token": auth.csrfToken,
      },
      body: JSON.stringify({
        nickname: "重复 Cookie",
        typingStatus: "测试中",
      }),
    });
    assert.ok(
      duplicateCookieResponse.status === 400 ||
        duplicateCookieResponse.status === 401,
      `重复 Cookie 应返回 400 或 401，实际为 ${duplicateCookieResponse.status}`,
    );
  });

  it("未认证请求不能读取举报审核后台", async () => {
    const response = await fetch(`${baseUrl}/api/admin/reports`);
    assert.equal(response.status, 401);
  });
});
