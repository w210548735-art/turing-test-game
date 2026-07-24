import { createHash } from "node:crypto";
import { createAuditStamp } from "../risk/audit.js";
import type {
  ModerationAction,
  ModerationCategory,
  ModerationDecision,
  ModerationInput,
  ModerationMatch,
  ModerationSurface,
} from "./types.js";

export const MODERATION_POLICY_VERSION = "alpha-2026-07-24.1";

interface Rule {
  id: string;
  category: ModerationCategory;
  action: Exclude<ModerationAction, "ALLOW">;
  pattern: RegExp;
  replacement?: string;
}

const RULES: Rule[] = [
  {
    id: "self-harm-imminent-zh-en",
    category: "SELF_HARM",
    action: "TERMINATE",
    pattern:
      /(?:我|本人).{0,8}(?:现在|今晚|马上|已经准备).{0,8}(?:自杀|跳楼|割腕|结束生命|不想活)|\b(?:i am going to|i'm going to|tonight i will)\b.{0,20}\b(?:kill myself|end my life|suicide)\b/giu,
  },
  {
    id: "credible-violent-threat",
    category: "VIOLENT_THREAT",
    action: "TERMINATE",
    pattern:
      /(?:我(?:现在|今晚|马上)?要|等着我).{0,10}(?:杀了你|砍死你|炸死你|找到你家)|\b(?:i will|i'm going to)\b.{0,20}\b(?:kill you|shoot you|bomb you)\b/giu,
  },
  {
    id: "minor-sexual",
    category: "MINOR_SEXUAL",
    action: "TERMINATE",
    pattern:
      /(?:未成年|儿童|小学生|初中生|幼女|幼童).{0,18}(?:裸照|成人视频|色情|性交|做爱|约炮)|(?:裸照|成人视频|色情|性交|做爱|约炮).{0,18}(?:未成年|儿童|小学生|初中生|幼女|幼童)|\b(?:child|minor|underage)\b.{0,18}\b(?:nude|porn|sex|sexual)\b/giu,
  },
  {
    id: "self-harm-methods",
    category: "SELF_HARM",
    action: "BLOCK",
    pattern:
      /(?:怎么|如何|哪种方法).{0,12}(?:自杀|割腕|上吊|结束生命)|\bhow (?:can|do) i\b.{0,16}\b(?:kill myself|commit suicide)\b/giu,
  },
  {
    id: "financial-scam",
    category: "SCAM",
    action: "BLOCK",
    pattern:
      /(?:稳赚不赔|保本高收益|内部投资群|刷单返现|垫资返佣|解冻账户|安全账户|验证码发给我|代收验证码|冒充公检法)|\b(?:guaranteed returns?|send me (?:the )?(?:otp|verification code)|advance fee|crypto doubling)\b/giu,
  },
  {
    id: "hate-targeted",
    category: "HATE",
    action: "BLOCK",
    pattern:
      /(?:所有|这些|那群).{0,8}(?:黑人|白人|犹太人|穆斯林|同性恋|残疾人|外地人).{0,10}(?:都该死|不是人|应该消失|低等)|\b(?:all|those)\b.{0,12}\b(?:blacks|jews|muslims|gays|disabled people)\b.{0,12}\b(?:must die|are animals|should disappear)\b/giu,
  },
  {
    id: "explicit-sexual",
    category: "SEXUAL",
    action: "BLOCK",
    pattern:
      /(?:发裸照|交换裸照|成人视频|约炮|性交细节|做爱细节)|\b(?:send nudes|exchange nudes|explicit sex|hardcore porn)\b/giu,
  },
  {
    id: "system-impersonation",
    category: "SYSTEM_IMPERSONATION",
    action: "BLOCK",
    pattern:
      /(?:我是|这里是|来自)\s*(?:系统|管理员|官方|客服|审核员)|\b(?:system|admin|moderator|official support)\s*(?:message|notice|account)\b/giu,
  },
  {
    id: "government-id",
    category: "PERSONAL_DATA",
    action: "REDACT",
    pattern:
      /(?<![A-Za-z0-9])(?:\d{17}[\dXx]|\d{15})(?![A-Za-z0-9])/gu,
    replacement: "[身份证号已隐藏]",
  },
  {
    id: "phone-number",
    category: "CONTACT",
    action: "REDACT",
    pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu,
    replacement: "[手机号已隐藏]",
  },
  {
    id: "email-address",
    category: "CONTACT",
    action: "REDACT",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: "[邮箱已隐藏]",
  },
  {
    id: "social-contact",
    category: "CONTACT",
    action: "REDACT",
    pattern:
      /(?:微信|微\s*信|vx|v信|wechat|qq|扣扣|telegram|电报|加我|联系我)\s*[:：号]?\s*[A-Za-z0-9_-]{4,}/giu,
    replacement: "[联系方式已隐藏]",
  },
  {
    id: "external-url",
    category: "URL",
    action: "REDACT",
    pattern:
      /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|cn|io|me|xyz|top|app|dev)\b(?:\/\S*)?/giu,
    replacement: "[链接已隐藏]",
  },
];

const ACTION_RANK: Record<ModerationAction, number> = {
  ALLOW: 0,
  REDACT: 1,
  BLOCK: 2,
  TERMINATE: 3,
};

function normalize(input: unknown, surface: ModerationSurface): string {
  if (typeof input !== "string") {
    throw new TypeError("Moderation input must be a string");
  }
  const maximum = surface === "REPORT_REASON" ? 500 : 500;
  const text = input
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, "")
    .trim();
  return [...text].slice(0, maximum).join("");
}

function userMessageFor(action: ModerationAction): string | undefined {
  switch (action) {
    case "REDACT":
      return "为保护隐私，消息中的联系方式、链接或个人信息已隐藏。";
    case "BLOCK":
      return "该内容不适合匿名聊天，消息未发送。";
    case "TERMINATE":
      return "检测到可能造成现实伤害的高风险内容，本局已停止并进入安全处置流程。";
    default:
      return undefined;
  }
}

export class ModerationPipeline {
  evaluate(input: ModerationInput, now = new Date()): ModerationDecision {
    const original = normalize(input.text, input.surface);
    let redacted = original;
    let action: ModerationAction = "ALLOW";
    const matches: ModerationMatch[] = [];

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(original)) continue;
      matches.push({
        ruleId: rule.id,
        category: rule.category,
        action: rule.action,
      });
      if (ACTION_RANK[rule.action] > ACTION_RANK[action]) {
        action = rule.action;
      }
      if (rule.action === "REDACT") {
        rule.pattern.lastIndex = 0;
        redacted = redacted.replace(
          rule.pattern,
          rule.replacement ?? "[内容已隐藏]",
        );
      }
    }

    const categories = [...new Set(matches.map((match) => match.category))];
    const immediateDanger = matches.some(
      (match) =>
        match.action === "TERMINATE" &&
        (match.category === "SELF_HARM" ||
          match.category === "VIOLENT_THREAT"),
    );
    const selfHarm = matches.some(
      (match) => match.category === "SELF_HARM",
    );
    return {
      action,
      text: action === "BLOCK" || action === "TERMINATE" ? "" : redacted,
      originalLength: [...original].length,
      categories,
      matches,
      ...(userMessageFor(action)
        ? { userMessage: userMessageFor(action) }
        : {}),
      ...(immediateDanger
        ? { safetyResourceCode: "IMMEDIATE_DANGER" as const }
        : selfHarm
          ? { safetyResourceCode: "SELF_HARM_SUPPORT" as const }
          : {}),
      audit: {
        ...createAuditStamp(input.audit, now),
        policyVersion: MODERATION_POLICY_VERSION,
        surface: input.surface,
        contentSha256: createHash("sha256").update(original).digest("hex"),
      },
    };
  }
}
