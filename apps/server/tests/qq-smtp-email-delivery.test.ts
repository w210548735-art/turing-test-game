import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { SendMailOptions } from "nodemailer";
import {
  loadQqSmtpConfig,
  QqSmtpConfigurationError,
  QqSmtpEmailDelivery,
  type SmtpTransport,
} from "../src/auth/index.js";

class RecordingTransport implements SmtpTransport {
  readonly messages: SendMailOptions[] = [];
  verified = false;
  closed = false;

  async sendMail(message: SendMailOptions): Promise<unknown> {
    this.messages.push(message);
    return { accepted: [message.to] };
  }

  async verify(): Promise<unknown> {
    this.verified = true;
    return true;
  }

  close(): void {
    this.closed = true;
  }
}

describe("QQ SMTP 邮件投递", () => {
  it("优先从 Secret 文件读取授权码并校验生产 HTTPS 地址", async () => {
    const authCodeFile = fileURLToPath(
      new URL("./fixtures/qq-auth-code.test-secret", import.meta.url),
    );
    const config = await loadQqSmtpConfig({
      QQ_SMTP_USER: "redacted@example.com",
      QQ_SMTP_AUTH_CODE: "ignored-direct-value",
      QQ_SMTP_AUTH_CODE_FILE: authCodeFile,
      QQ_SMTP_FROM_NAME: "图灵测试",
      PUBLIC_WEB_URL: "https://game.example.com/",
      NODE_ENV: "production",
    });

    assert.equal(config.user, "redacted@example.com");
    assert.equal(config.authCode, "test-only-auth-code");
    assert.equal(config.publicBaseUrl, "https://game.example.com");
  });

  it("生成验证与重置邮件但不向主题或地址字段泄漏授权码", async () => {
    const transport = new RecordingTransport();
    const delivery = new QqSmtpEmailDelivery(
      {
        user: "redacted@example.com",
        authCode: "transport-secret",
        fromName: "图灵测试",
        publicBaseUrl: "https://game.example.com",
      },
      transport,
    );

    await delivery.verifyConnection();
    await delivery.send({
      to: "user@example.com",
      purpose: "EMAIL_VERIFICATION",
      token: "verification-token",
      expiresAt: new Date("2026-07-25T00:00:00.000Z"),
    });
    await delivery.send({
      to: "user@example.com",
      purpose: "PASSWORD_RESET",
      token: "reset-token",
      expiresAt: new Date("2026-07-24T00:30:00.000Z"),
    });
    delivery.close();

    assert.equal(transport.verified, true);
    assert.equal(transport.closed, true);
    assert.equal(transport.messages.length, 2);
    const serialized = JSON.stringify(transport.messages);
    assert.equal(serialized.includes("transport-secret"), false);
    assert.match(
      String(transport.messages[0]?.html),
      /verify-email\?token=verification-token/u,
    );
    assert.match(
      String(transport.messages[1]?.text),
      /reset-password\?token=reset-token/u,
    );
  });

  it("拒绝非 QQ 发件人和生产 HTTP 回调地址", async () => {
    await assert.rejects(
      loadQqSmtpConfig({
        QQ_SMTP_USER: "sender@example.com",
        QQ_SMTP_AUTH_CODE: "test-auth-code",
        PUBLIC_WEB_URL: "https://game.example.com",
        NODE_ENV: "production",
      }),
      QqSmtpConfigurationError,
    );
    await assert.rejects(
      loadQqSmtpConfig({
        QQ_SMTP_USER: "redacted@example.com",
        QQ_SMTP_AUTH_CODE: "test-auth-code",
        PUBLIC_WEB_URL: "http://game.example.com",
        NODE_ENV: "production",
      }),
      QqSmtpConfigurationError,
    );
  });
});
