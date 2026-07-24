import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModerationPipeline } from "./pipeline.js";

const pipeline = new ModerationPipeline();
const base = {
  surface: "CHAT" as const,
  audit: { actorId: "user-1", traceId: "trace-1" },
};

describe("ModerationPipeline", () => {
  it("allows ordinary conversation and emits audit metadata", () => {
    const result = pipeline.evaluate({ ...base, text: "你最近看了什么电影？" });
    assert.equal(result.action, "ALLOW");
    assert.equal(result.audit.traceId, "trace-1");
    assert.equal(result.audit.contentSha256.length, 64);
  });

  it("redacts contacts without preserving the original in audit fields", () => {
    const result = pipeline.evaluate({
      ...base,
      text: "加我微信:abcd1234，电话13800138000",
    });
    assert.equal(result.action, "REDACT");
    assert.equal(result.text.includes("abcd1234"), false);
    assert.equal(result.text.includes("13800138000"), false);
    assert.equal(JSON.stringify(result.audit).includes("abcd1234"), false);
  });

  it("blocks scams, targeted hate, and explicit sexual content", () => {
    for (const text of [
      "加入内部投资群，保证稳赚不赔",
      "这些残疾人都不是人",
      "我们交换裸照吧",
    ]) {
      const result = pipeline.evaluate({ ...base, text });
      assert.equal(result.action, "BLOCK");
      assert.equal(result.text, "");
    }
  });

  it("terminates imminent self-harm, credible threats, and minor sexual content", () => {
    for (const text of [
      "我今晚要结束生命",
      "我马上要找到你家杀了你",
      "想要未成年人的裸照",
    ]) {
      const result = pipeline.evaluate({ ...base, text });
      assert.equal(result.action, "TERMINATE");
      assert.equal(result.text, "");
    }
  });
});
