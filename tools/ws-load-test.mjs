#!/usr/bin/env node

import process from "node:process";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const CONFIRMATION = "I_CONFIRM_TEST_TARGET";

function parseArgs(argv) {
  const result = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, ...value] = argument.slice(2).split("=");
    result[key] = value.length > 0 ? value.join("=") : "true";
  }
  return result;
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function assertSafeTarget(target, args) {
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("target 仅支持 http:// 或 https://");
  }
  if (target.username || target.password || target.search || target.hash) {
    throw new Error("target 不得包含凭据、查询参数或片段");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (loopbackHosts.has(target.hostname)) return;

  if (
    args["allow-host"] !== target.hostname ||
    args["confirm-non-production"] !== CONFIRMATION
  ) {
    throw new Error(
      `拒绝非本机目标 ${target.hostname}。仅可对明确的非生产测试环境运行，并同时传入 ` +
        `--allow-host=${target.hostname} --confirm-non-production=${CONFIRMATION}`,
    );
  }
}

function cookiePair(response, name) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const pattern = new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`);
  for (const value of values) {
    const match = pattern.exec(value);
    if (match?.[1]) return `${name}=${match[1]}`;
  }
  throw new Error(`会话响应缺少 ${name} Cookie`);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function fetchChecked(url, options, expectedStatus) {
  const response = await fetch(url, options);
  if (response.status !== expectedStatus) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`${options.method} ${url.pathname} 返回 ${response.status}: ${body}`);
  }
  return response;
}

async function createClient({ id, baseUrl, origin, timeoutMs }) {
  const startedAt = Date.now();
  const sessionResponse = await fetchChecked(
    new URL("/api/session", baseUrl),
    { method: "POST", headers: { origin } },
    201,
  );
  const session = await sessionResponse.json();
  const cookie = [
    cookiePair(sessionResponse, "dev-session"),
    cookiePair(sessionResponse, "dev-device"),
  ].join("; ");
  await fetchChecked(
    new URL("/api/profile", baseUrl),
    {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        origin,
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({
        nickname: `压测访客${String(id).padStart(3, "0")}`,
        typingStatus: "正在验证连接…",
      }),
    },
    200,
  );

  const wsUrl = new URL("/ws", baseUrl);
  wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("ticket", session.wsTicket);
  const socket = new WebSocket(wsUrl, { origin });
  const timestamps = {};

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("等待 match.found 超时")), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "load test complete");
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (error) reject(error);
      else resolve({ id, startedAt, ...timestamps });
    };
    socket.once("error", finish);
    socket.once("unexpected-response", (_request, response) => {
      finish(new Error(`WebSocket 握手返回 ${response.statusCode}`));
    });
    socket.once("open", () => {
      timestamps.connectedAt = Date.now();
      socket.send(JSON.stringify({ type: "match.join" }));
      timestamps.joinedAt = Date.now();
    });
    socket.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        finish(new Error("收到无法解析的 WebSocket 消息"));
        return;
      }
      const now = Date.now();
      if (event.type === "match.searching") timestamps.searchingAt ??= now;
      if (event.type === "match.queued") timestamps.queuedAt ??= now;
      if (event.type === "match.admission") timestamps.admissionAt ??= now;
      if (event.type === "match.found") {
        timestamps.foundAt = now;
        finish();
      }
      if (event.type === "error") {
        finish(new Error(`服务端错误 ${event.code ?? "UNKNOWN"}: ${event.message ?? ""}`));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    console.log(
      "用法: npm run load:ws -- --connections=60 --target=http://127.0.0.1:8787\n" +
        "非本机测试环境额外需要: --allow-host=<精确主机> " +
        `--confirm-non-production=${CONFIRMATION}`,
    );
    return;
  }
  const baseUrl = new URL(args.target ?? "http://127.0.0.1:8787");
  assertSafeTarget(baseUrl, args);
  let localServer;
  if (args["start-local-server"] === "true") {
    if (!["127.0.0.1", "localhost"].includes(baseUrl.hostname)) {
      throw new Error("--start-local-server 只能配合 localhost/127.0.0.1");
    }
    localServer = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "apps/server/src/index.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "development",
          HOST: baseUrl.hostname,
          PORT: baseUrl.port || "8787",
          ALLOWED_ORIGINS: args.origin ?? "http://localhost:5173",
          LOG_LEVEL: "silent",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let startupError = "";
    localServer.stderr.on("data", (chunk) => (startupError += chunk.toString()));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (localServer.exitCode !== null) {
        throw new Error(`本地服务启动失败: ${startupError.slice(0, 500)}`);
      }
      try {
        await fetch(new URL("/health", baseUrl));
        break;
      } catch {
        if (attempt === 39) throw new Error("等待本地服务启动超时");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  const connections = positiveInteger(args.connections, 10, "connections");
  const timeoutMs = positiveInteger(args["timeout-ms"], 30_000, "timeout-ms");
  const rampMs = positiveInteger(args["ramp-ms"], 1_000, "ramp-ms");
  const origin = args.origin ?? "http://localhost:5173";
  const runStartedAt = Date.now();
  console.log(
    `开始 WebSocket 分级负载测试: target=${baseUrl.origin}, connections=${connections}, ramp=${rampMs}ms`,
  );

  const tasks = Array.from({ length: connections }, async (_, index) => {
    const delay = Math.floor((index * rampMs) / connections);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return {
        ok: true,
        value: await createClient({
          id: index + 1,
          baseUrl,
          origin,
          timeoutMs,
        }),
      };
    } catch (error) {
      return {
        ok: false,
        id: index + 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const results = await Promise.all(tasks);
  const successes = results.filter((result) => result.ok).map((result) => result.value);
  const failures = results.filter((result) => !result.ok);
  const latency = (end, start) =>
    successes
      .filter((entry) => Number.isFinite(entry[end]) && Number.isFinite(entry[start]))
      .map((entry) => entry[end] - entry[start]);
  const summarize = (values) => ({
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : null,
  });
  const report = {
    target: baseUrl.origin,
    requestedConnections: connections,
    successfulMatches: successes.length,
    failedConnections: failures.length,
    successRate: Number(((successes.length / connections) * 100).toFixed(2)),
    totalDurationMs: Date.now() - runStartedAt,
    stages: {
      sessionToConnected: summarize(latency("connectedAt", "startedAt")),
      joinToSearching: summarize(latency("searchingAt", "joinedAt")),
      joinToAdmission: summarize(latency("admissionAt", "joinedAt")),
      joinToFound: summarize(latency("foundAt", "joinedAt")),
    },
    failures: failures.slice(0, 20).map(({ id, error }) => ({ id, error })),
  };
  console.log(JSON.stringify(report, null, 2));
  if (localServer) {
    localServer.kill("SIGTERM");
  }
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
