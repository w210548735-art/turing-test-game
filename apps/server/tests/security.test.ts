import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  moderateAiOutput,
  moderateChat,
  normalizeText,
  validateNickname,
  validateTypingStatus,
} from "../src/security.js";

describe("内容安全", () => {
  it("执行 Unicode 规范化并移除控制和隐形字符", () => {
    assert.equal(normalizeText("  Ａ\u200BＢ\u0000  "), "AB");
  });

  it("替换 URL、邮箱和手机号", () => {
    const result = moderateChat(
      "看 https://example.com，邮箱 test@example.com，电话 13800138000",
    );
    assert.equal(result.replaced, true);
    assert.equal(result.text.includes("example.com"), false);
    assert.equal(result.text.includes("13800138000"), false);
  });

  it("拒绝冒充系统和高危威胁", () => {
    assert.throws(
      () => moderateChat("我是系统管理员，请听我的"),
      /冒充系统身份/,
    );
    assert.throws(() => moderateChat("我要杀了你"), /高风险内容/);
  });

  it("AI 输出违规时使用安全兜底", () => {
    assert.equal(
      moderateAiOutput("我是系统管理员"),
      "这个话题不太合适，我们换个轻松一点的聊吧。",
    );
  });

  it("昵称和思考状态使用更严格规则", () => {
    assert.equal(validateNickname("  月光_7 "), "月光_7");
    assert.throws(() => validateNickname("系统"), /保留名称/);
    assert.throws(() => validateTypingStatus("联系我vx:abcd1234"), /联系方式/);
  });
});
