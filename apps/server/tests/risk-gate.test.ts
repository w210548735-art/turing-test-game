import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ActionBoundCaptchaService,
  DecayingMemoryRiskSignalRepository,
  RuleRiskGate,
  TestCaptchaProvider,
  type RiskGateConfig,
} from "../src/risk-gate/index.js";

const config: RiskGateConfig = {
  thresholds: {
    throttle: 10,
    captcha: 25,
    limit: 50,
    reject: 80,
  },
  halfLifeMs: 1_000,
  retentionMs: 10_000,
  maximumScore: 100,
};

describe("规则风险门", () => {
  it("按可配置阈值逐级升级动作", () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const repository = new DecayingMemoryRiskSignalRepository(
      config.retentionMs,
    );
    const gate = new RuleRiskGate(repository, config, () => now);

    assert.equal(gate.assess("user:1").action, "ALLOW");
    gate.record({ subjectKey: "user:1", type: "NEW_DEVICE", weight: 10 });
    assert.equal(gate.assess("user:1").action, "THROTTLE");
    gate.record({ subjectKey: "user:1", type: "LOGIN_FAILURE", weight: 15 });
    assert.equal(gate.assess("user:1").action, "CAPTCHA");
    gate.record({ subjectKey: "user:1", type: "RATE_ABUSE", weight: 25 });
    assert.equal(gate.assess("user:1").action, "LIMIT");
    gate.record({ subjectKey: "user:1", type: "BAN_EVASION", weight: 30 });
    assert.equal(gate.assess("user:1").action, "REJECT");
    assert.deepEqual(gate.assess("user:1").reasons, [
      "BAN_EVASION",
      "RATE_ABUSE",
      "LOGIN_FAILURE",
      "NEW_DEVICE",
    ]);

    now = new Date(now.getTime() + 500);
    assert.ok(gate.assess("user:1").score < 80);
  });

  it("按半衰期衰减并在保留期后清理信号", () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const repository = new DecayingMemoryRiskSignalRepository(
      config.retentionMs,
    );
    const gate = new RuleRiskGate(repository, config, () => now);
    gate.record({ subjectKey: "ip:1", type: "RATE_ABUSE", weight: 40 });

    now = new Date(now.getTime() + config.halfLifeMs);
    const decayed = gate.assess("ip:1");
    assert.ok(Math.abs(decayed.score - 20) < 0.000_001);
    assert.equal(decayed.action, "THROTTLE");

    now = new Date(now.getTime() + config.retentionMs);
    assert.deepEqual(gate.assess("ip:1"), {
      subjectKey: "ip:1",
      score: 0,
      action: "ALLOW",
      reasons: [],
      assessedAt: now,
    });
  });
});

describe("动作绑定验证码", () => {
  it("验证成功后 Token 不可重放", async () => {
    const provider = new TestCaptchaProvider();
    const service = new ActionBoundCaptchaService(provider);
    const ticket = service.issue("START_MATCH");

    assert.equal(
      await service.verify({
        token: ticket.token,
        action: "START_MATCH",
        response: "captcha-ok",
      }),
      true,
    );
    assert.equal(
      await service.verify({
        token: ticket.token,
        action: "START_MATCH",
        response: "captcha-ok",
      }),
      false,
    );
    assert.equal(provider.calls.length, 1);
  });

  it("拒绝过期 Token，且不调用供应商", async () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const provider = new TestCaptchaProvider();
    const service = new ActionBoundCaptchaService(
      provider,
      1_000,
      () => now,
    );
    const ticket = service.issue("LOGIN");
    now = new Date(now.getTime() + 1_001);

    assert.equal(
      await service.verify({
        token: ticket.token,
        action: "LOGIN",
        response: "captcha-ok",
      }),
      false,
    );
    assert.equal(provider.calls.length, 0);
  });

  it("拒绝动作不匹配并消费可疑 Token", async () => {
    const provider = new TestCaptchaProvider();
    const service = new ActionBoundCaptchaService(provider);
    const ticket = service.issue("LOGIN");

    assert.equal(
      await service.verify({
        token: ticket.token,
        action: "START_MATCH",
        response: "captcha-ok",
      }),
      false,
    );
    assert.equal(
      await service.verify({
        token: ticket.token,
        action: "LOGIN",
        response: "captcha-ok",
      }),
      false,
    );
    assert.equal(provider.calls.length, 0);
  });
});
