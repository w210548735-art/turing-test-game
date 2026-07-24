import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { EmailDelivery, EmailMessage } from "./auth-service.js";
import { canonicalizeEmail } from "./email.js";

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

export class QqSmtpEmailDelivery implements EmailDelivery {
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
}
