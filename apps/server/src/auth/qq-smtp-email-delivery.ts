import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { EmailDelivery, EmailMessage } from "./auth-service.js";
import { canonicalizeEmail } from "./email.js";
import type {
  FeedbackDigestEmailMessage,
  FeedbackEmailDelivery,
} from "../feedback/types.js";

const QQ_SMTP_HOST = "smtp.qq.com";
const QQ_SMTP_PORT = 465;

export interface QqSmtpConfig {
  readonly user: string;
  readonly authCode: string;
  readonly fromName: string;
  readonly publicBaseUrl: string;
}

export interface SmtpTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
  verify(): Promise<unknown>;
  close?(): void;
}

export interface QqSmtpEnvironment {
  readonly QQ_SMTP_USER?: string;
  readonly QQ_SMTP_AUTH_CODE?: string;
  readonly QQ_SMTP_AUTH_CODE_FILE?: string;
  readonly QQ_SMTP_FROM_NAME?: string;
  readonly PUBLIC_WEB_URL?: string;
  readonly NODE_ENV?: string;
}

export class QqSmtpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QqSmtpConfigurationError";
  }
}

async function readSecretFile(path: string): Promise<string> {
  try {
    const value = (await readFile(resolve(path), "utf8")).trim();
    if (!value) {
      throw new QqSmtpConfigurationError("QQ SMTP 授权码文件为空");
    }
    return value;
  } catch (error) {
    if (error instanceof QqSmtpConfigurationError) throw error;
    throw new QqSmtpConfigurationError("无法读取 QQ SMTP 授权码文件");
  }
}

function requiredValue(
  value: string | undefined,
  label: string,
): string {
  const normalized = value?.normalize("NFKC").trim();
  if (!normalized) {
    throw new QqSmtpConfigurationError(`${label} 未配置`);
  }
  return normalized;
}

function validateSingleLine(value: string, label: string, maxLength: number): string {
  if (value.length > maxLength || /[\r\n\0]/u.test(value)) {
    throw new QqSmtpConfigurationError(`${label} 不合法`);
  }
  return value;
}

function validatePublicBaseUrl(
  value: string,
  production: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new QqSmtpConfigurationError("PUBLIC_WEB_URL 不是有效 URL");
  }
  const localDevelopment =
    !production &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    (parsed.protocol !== "https:" && !localDevelopment) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new QqSmtpConfigurationError(
      "PUBLIC_WEB_URL 必须是 HTTPS Origin，本地开发可使用 localhost HTTP",
    );
  }
  return parsed.origin;
}

/**
 * 授权码优先从只读 Secret 文件读取。环境变量只作为无法挂载 Secret
 * 文件的平台兼容入口，任何一种方式都不得写入日志或仓库。
 */
export async function loadQqSmtpConfig(
  environment: QqSmtpEnvironment = process.env,
): Promise<QqSmtpConfig> {
  const user = canonicalizeEmail(
    requiredValue(environment.QQ_SMTP_USER, "QQ_SMTP_USER"),
  );
  if (!user.endsWith("@qq.com") && !user.endsWith("@foxmail.com")) {
    throw new QqSmtpConfigurationError(
      "QQ_SMTP_USER 必须是 QQ 邮箱或 Foxmail 邮箱",
    );
  }
  const authCodeFile = environment.QQ_SMTP_AUTH_CODE_FILE?.trim();
  const authCode = authCodeFile
    ? await readSecretFile(authCodeFile)
    : requiredValue(
        environment.QQ_SMTP_AUTH_CODE,
        "QQ_SMTP_AUTH_CODE 或 QQ_SMTP_AUTH_CODE_FILE",
      );
  validateSingleLine(authCode, "QQ SMTP 授权码", 256);
  const fromName = validateSingleLine(
    environment.QQ_SMTP_FROM_NAME?.normalize("NFKC").trim() ||
      "图灵测试",
    "QQ_SMTP_FROM_NAME",
    80,
  );
  const publicBaseUrl = validatePublicBaseUrl(
    requiredValue(environment.PUBLIC_WEB_URL, "PUBLIC_WEB_URL"),
    environment.NODE_ENV === "production",
  );
  return { user, authCode, fromName, publicBaseUrl };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function feedbackCategoryLabel(
  category: FeedbackDigestEmailMessage["digest"]["feedback"][number]["category"],
): string {
  return {
    bug: "问题 / Bug",
    suggestion: "功能建议",
    other: "其他反馈",
  }[category];
}

function digestDate(message: FeedbackDigestEmailMessage): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(message.digest.cutoffAt);
}

function feedbackDigestText(message: FeedbackDigestEmailMessage): string {
  const header = [
    `图灵测试每日反馈汇总（${digestDate(message)} 北京时间 10:00）`,
    `批次编号：${message.digest.id}`,
    `反馈数量：${message.digest.feedback.length}`,
    "",
  ];
  const rows = message.digest.feedback.flatMap((feedback, index) => [
    `${index + 1}. [${feedbackCategoryLabel(feedback.category)}] ${feedback.title}`,
    `反馈编号：${feedback.id}`,
    `账户 ID：${feedback.userId ?? "账户已删除"}`,
    `提交时间：${feedback.createdAt.toISOString()}`,
    feedback.details,
    "",
  ]);
  return [...header, ...rows].join("\n");
}

function feedbackDigestHtml(message: FeedbackDigestEmailMessage): string {
  const cell = (value: string) =>
    `<td style="vertical-align:top;padding:8px;border:1px solid #222;word-break:break-word">${escapeHtml(value).replace(/\r?\n/gu, "<br>")}</td>`;
  const rows = message.digest.feedback.map(
    (feedback, index) =>
      `<tr>${cell(String(index + 1))}${cell(feedback.id)}${cell(feedbackCategoryLabel(feedback.category))}${cell(feedback.userId ?? "账户已删除")}${cell(feedback.createdAt.toISOString())}${cell(feedback.title)}${cell(feedback.details)}</tr>`,
  );
  return [
    `<h1>图灵测试每日反馈汇总</h1>`,
    `<p>截止时间：${escapeHtml(digestDate(message))} 北京时间 10:00</p>`,
    `<p>批次编号：${escapeHtml(message.digest.id)}；反馈数量：${message.digest.feedback.length}</p>`,
    '<table style="border-collapse:collapse;width:100%">',
    '<thead><tr style="background:#fff4d6"><th style="padding:8px;border:1px solid #222">#</th><th style="padding:8px;border:1px solid #222">反馈编号</th><th style="padding:8px;border:1px solid #222">分类</th><th style="padding:8px;border:1px solid #222">账户 ID</th><th style="padding:8px;border:1px solid #222">提交时间</th><th style="padding:8px;border:1px solid #222">标题</th><th style="padding:8px;border:1px solid #222">详细内容</th></tr></thead>',
    `<tbody>${rows.join("")}</tbody>`,
    "</table>",
  ].join("");
}

function buildActionUrl(config: QqSmtpConfig, message: EmailMessage): string {
  const path =
    message.purpose === "EMAIL_VERIFICATION"
      ? "/verify-email"
      : "/reset-password";
  const url = new URL(path, config.publicBaseUrl);
  url.searchParams.set("token", message.token);
  return url.toString();
}

function buildMail(
  config: QqSmtpConfig,
  message: EmailMessage,
): SendMailOptions {
  const target = canonicalizeEmail(message.to);
  const actionUrl = buildActionUrl(config, message);
  const verification = message.purpose === "EMAIL_VERIFICATION";
  const title = verification ? "验证你的邮箱" : "重置你的密码";
  const action = verification ? "完成邮箱验证" : "重置密码";
  const expiry = message.expiresAt.toISOString();
  const text = [
    `${title}`,
    "",
    `请打开以下链接${action}：`,
    actionUrl,
    "",
    `链接过期时间：${expiry}`,
    "如果这不是你的操作，请忽略本邮件。",
  ].join("\n");
  return {
    from: { name: config.fromName, address: config.user },
    to: target,
    subject: `【图灵测试】${title}`,
    text,
    html: [
      `<h1>${escapeHtml(title)}</h1>`,
      `<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(action)}</a></p>`,
      `<p>链接过期时间：${escapeHtml(expiry)}</p>`,
      "<p>如果这不是你的操作，请忽略本邮件。</p>",
    ].join(""),
  };
}

export class QqSmtpEmailDelivery
  implements EmailDelivery, FeedbackEmailDelivery
{
  readonly #transport: SmtpTransport;

  constructor(
    private readonly config: QqSmtpConfig,
    transport?: SmtpTransport,
  ) {
    this.#transport =
      transport ??
      nodemailer.createTransport({
        host: QQ_SMTP_HOST,
        port: QQ_SMTP_PORT,
        secure: true,
        pool: true,
        maxConnections: 2,
        maxMessages: 50,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        dnsTimeout: 5_000,
        auth: {
          user: config.user,
          pass: config.authCode,
        },
        logger: false,
        debug: false,
      });
  }

  async verifyConnection(): Promise<void> {
    await this.#transport.verify();
  }

  close(): void {
    this.#transport.close?.();
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail(buildMail(this.config, message));
  }

  async sendFeedbackDigest(
    message: FeedbackDigestEmailMessage,
  ): Promise<void> {
    const target = canonicalizeEmail(message.to);
    await this.#transport.sendMail({
      from: { name: this.config.fromName, address: this.config.user },
      to: target,
      messageId: message.digest.messageId,
      subject: `【图灵测试】每日反馈汇总 · ${digestDate(message)}`,
      text: feedbackDigestText(message),
      html: feedbackDigestHtml(message),
    });
  }
}
