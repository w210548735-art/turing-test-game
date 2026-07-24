import { AppError } from "./errors.js";

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const URL_PATTERN =
  /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|cn|io|me|xyz|top|app|dev)\b(?:\/\S*)?/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu;
const CONTACT_PATTERN =
  /(?:微信|微\s*信|vx|v信|wechat|qq|扣扣|telegram|电报|手机号|电话|加我|联系我)\s*[:：号]?\s*[A-Za-z0-9_-]{4,}/giu;
const SYSTEM_IMPERSONATION_PATTERN =
  /(?:我是|这里是|来自)\s*(?:系统|管理员|官方|客服|开发者|审核员)|(?:system|admin|moderator|official)\s*(?:message|notice|support)/giu;
const PROMPT_ATTACK_PATTERN =
  /(?:忽略|无视|覆盖|泄露|展示).{0,12}(?:指令|提示词|系统消息|规则)|(?:ignore|reveal|override).{0,18}(?:instructions?|prompt|system message)/giu;
const SEVERE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "THREAT",
    pattern:
      /(?:杀了你|弄死你|砍死你|炸死你|找到你家|kill\s+you|bomb\s+you)/giu,
  },
  {
    code: "MINOR_SEXUAL",
    pattern:
      /(?:未成年|小学生|初中生|儿童|幼女).{0,12}(?:裸照|色情|约炮|性交|做爱)|(?:child|minor).{0,12}(?:nude|sex|porn)/giu,
  },
  {
    code: "DOXXING",
    pattern:
      /(?:身份证号|家庭住址|开户地址|银行卡号)\s*[:：]?\s*[A-Za-z0-9\-]{6,}/giu,
  },
  {
    code: "ILLEGAL_TRADE",
    pattern:
      /(?:出售|购买|收购|交易).{0,10}(?:毒品|枪支|身份证|银行卡|人口)|(?:buy|sell).{0,12}(?:drugs|firearm|stolen card)/giu,
  },
];

export interface ModerationResult {
  text: string;
  replaced: boolean;
}

export function normalizeText(input: unknown): string {
  if (typeof input !== "string") {
    throw new AppError("INVALID_TEXT", "内容必须是文本。");
  }
  return input
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .trim();
}

export function moderateChat(input: unknown): ModerationResult {
  const normalized = normalizeText(input);
  if (!normalized) {
    throw new AppError("EMPTY_MESSAGE", "消息不能为空。");
  }
  if ([...normalized].length > 100) {
    throw new AppError("MESSAGE_TOO_LONG", "每条消息最多 100 个字符。");
  }

  for (const rule of SEVERE_PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(normalized)) {
      throw new AppError(
        `CONTENT_${rule.code}`,
        "消息包含不适合匿名聊天的高风险内容。",
      );
    }
  }

  SYSTEM_IMPERSONATION_PATTERN.lastIndex = 0;
  PROMPT_ATTACK_PATTERN.lastIndex = 0;
  if (
    SYSTEM_IMPERSONATION_PATTERN.test(normalized) ||
    PROMPT_ATTACK_PATTERN.test(normalized)
  ) {
    throw new AppError(
      "CONTENT_IMPERSONATION",
      "请勿冒充系统身份或发送操纵系统的指令。",
    );
  }

  let text = normalized;
  for (const pattern of [
    URL_PATTERN,
    EMAIL_PATTERN,
    PHONE_PATTERN,
    CONTACT_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[联系方式已隐藏]");
  }
  return { text, replaced: text !== normalized };
}

export function moderateAiOutput(input: unknown): string {
  try {
    return moderateChat(input).text;
  } catch {
    return "这个话题不太合适，我们换个轻松一点的聊吧。";
  }
}

function ensureNoContactOrReserved(text: string): void {
  for (const pattern of [
    URL_PATTERN,
    EMAIL_PATTERN,
    PHONE_PATTERN,
    CONTACT_PATTERN,
    SYSTEM_IMPERSONATION_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      throw new AppError(
        "INVALID_PROFILE_CONTENT",
        "昵称或思考状态不能包含联系方式、链接或系统身份。",
      );
    }
  }
}

export function validateNickname(input: unknown): string {
  const text = normalizeText(input).replace(/\s+/gu, " ");
  const length = [...text].length;
  if (length < 2 || length > 16) {
    throw new AppError("INVALID_NICKNAME", "昵称需要 2 到 16 个字符。");
  }
  if (!/^[\p{L}\p{N}_\-· ]+$/u.test(text)) {
    throw new AppError(
      "INVALID_NICKNAME",
      "昵称只能使用文字、数字、空格、下划线、短横线或间隔号。",
    );
  }
  if (
    /^(?:ai|人工智能|机器人|系统|管理员|官方|客服|审核员|deepseek)$/iu.test(
      text,
    )
  ) {
    throw new AppError("RESERVED_NICKNAME", "该昵称为系统保留名称。");
  }
  ensureNoContactOrReserved(text);
  return text;
}

export function validateTypingStatus(input: unknown): string {
  const text = normalizeText(input).replace(/\s+/gu, " ");
  if ([...text].length > 30) {
    throw new AppError(
      "INVALID_TYPING_STATUS",
      "思考状态最多 30 个字符。",
    );
  }
  ensureNoContactOrReserved(text);
  for (const rule of SEVERE_PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      throw new AppError(
        "INVALID_PROFILE_CONTENT",
        "思考状态包含不安全内容。",
      );
    }
  }
  return text || "正在组织语言…";
}

export function validateReportReason(input: unknown): string {
  const text = normalizeText(input);
  if ([...text].length < 2 || [...text].length > 200) {
    throw new AppError(
      "INVALID_REPORT_REASON",
      "举报原因需要 2 到 200 个字符。",
    );
  }
  return text;
}
