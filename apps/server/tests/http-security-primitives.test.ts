import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSecurityHeaders,
  createSecurityCookiePolicy,
  OriginPolicy,
  OriginPolicyError,
  parseCookieHeader,
  serializeDeviceCookie,
  serializeSessionCookie,
  SessionBoundCsrfService,
} from "../src/http-security/index.js";

describe("安全 Cookie", () => {
  it("生产环境使用 __Host 名称和完整安全属性", () => {
    const policy = createSecurityCookiePolicy("production");
    assert.deepEqual(policy.names, {
      session: "__Host-session",
      device: "__Host-device",
    });
    assert.equal(
      serializeSessionCookie("session-value", policy),
      "__Host-session=session-value; Path=/; SameSite=Lax; HttpOnly; Secure",
    );
    assert.equal(
      serializeDeviceCookie("device-value", policy),
      "__Host-device=device-value; Path=/; SameSite=Lax; HttpOnly; Secure",
    );
  });

  it("开发环境使用不同名称且不伪装 Secure", () => {
    const policy = createSecurityCookiePolicy("development");
    assert.deepEqual(policy.names, {
      session: "dev-session",
      device: "dev-device",
    });
    assert.equal(
      serializeSessionCookie("local", policy),
      "dev-session=local; Path=/; SameSite=Lax; HttpOnly",
    );
  });

  it("解析值内等号并拒绝重复名称", () => {
    const parsed = parseCookieHeader("a=one; token=a=b=c");
    assert.equal(parsed.get("a"), "one");
    assert.equal(parsed.get("token"), "a=b=c");
    assert.throws(
      () => parseCookieHeader("session=first; session=second"),
      /重复名称/u,
    );
  });
});

describe("会话绑定 CSRF", () => {
  const service = new SessionBoundCsrfService("x".repeat(32));

  it("签发随机 Token，仅以摘要校验", () => {
    const first = service.issue("session-a");
    const second = service.issue("session-a");
    assert.notEqual(first.token, second.token);
    assert.match(first.hash, /^[a-f0-9]{64}$/u);
    assert.equal(service.verify("session-a", first.token, first.hash), true);
    assert.equal(service.verify("session-a", `${first.token}x`, first.hash), false);
  });

  it("阻止跨 Session 复用，并在轮换后让旧 Token 失效", () => {
    const oldToken = service.issue("session-a");
    const rotated = service.rotate("session-a");
    assert.equal(service.verify("session-b", oldToken.token, oldToken.hash), false);
    assert.equal(service.verify("session-a", oldToken.token, rotated.hash), false);
    assert.equal(service.verify("session-a", rotated.token, rotated.hash), true);
    assert.equal(service.verify("session-a", undefined, rotated.hash), false);
    assert.equal(service.verify("session-a", rotated.token, "invalid"), false);
  });
});

describe("Origin 策略", () => {
  const policy = new OriginPolicy(["https://game.example"]);

  it("修改请求缺失 Origin 时拒绝，安全读取请求可以通过", () => {
    assert.deepEqual(policy.evaluateHttp("POST", undefined), {
      allowed: false,
      reason: "MISSING_ORIGIN",
    });
    assert.deepEqual(policy.evaluateHttp("GET", undefined), {
      allowed: true,
      reason: "ALLOWED",
    });
  });

  it("WebSocket 缺失 Origin 时拒绝，且仅精确匹配白名单", () => {
    assert.throws(
      () => policy.assertWebSocket(undefined),
      (error: unknown) =>
        error instanceof OriginPolicyError &&
        error.code === "MISSING_ORIGIN",
    );
    assert.equal(
      policy.evaluateWebSocket("https://game.example").allowed,
      true,
    );
    assert.deepEqual(
      policy.evaluateWebSocket("https://game.example.evil.test"),
      {
        allowed: false,
        reason: "DISALLOWED_ORIGIN",
      },
    );
    assert.equal(
      policy.evaluateHttp("POST", "https://game.example/").allowed,
      false,
    );
  });

  it("拒绝带路径或非规范化的白名单配置", () => {
    assert.throws(
      () => new OriginPolicy(["https://game.example/path"]),
      /规范化/u,
    );
    assert.throws(
      () => new OriginPolicy(["https://game.example/"]),
      /规范化/u,
    );
  });
});

describe("安全响应头", () => {
  it("生产环境包含严格 CSP、HSTS 和基础响应头", () => {
    const headers = buildSecurityHeaders({
      production: true,
      connectSources: ["wss://game.example"],
    });
    assert.match(headers["Content-Security-Policy"] ?? "", /script-src 'self'/u);
    assert.match(headers["Content-Security-Policy"] ?? "", /frame-ancestors 'none'/u);
    assert.match(
      headers["Content-Security-Policy"] ?? "",
      /connect-src 'self' wss:\/\/game\.example/u,
    );
    assert.equal(
      headers["Strict-Transport-Security"],
      "max-age=31536000; includeSubDomains",
    );
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
  });

  it("开发环境不发送 HSTS，并拒绝任意来源 CSP", () => {
    const headers = buildSecurityHeaders({ production: false });
    assert.equal(headers["Strict-Transport-Security"], undefined);
    assert.throws(
      () =>
        buildSecurityHeaders({
          production: true,
          connectSources: ["*"],
        }),
      /CSP connect-src/u,
    );
  });
});
