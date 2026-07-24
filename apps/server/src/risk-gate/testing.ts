import type { CaptchaProvider } from "./captcha.js";

/** 仅供自动化测试和本地开发注入，不代表真实人机验证。 */
export class TestCaptchaProvider implements CaptchaProvider {
  readonly calls: Array<{
    response: string;
    action: string;
    remoteIp?: string;
  }> = [];

  constructor(
    private readonly acceptedResponse = "captcha-ok",
  ) {}

  async verify(input: {
    readonly response: string;
    readonly action: string;
    readonly remoteIp?: string;
  }): Promise<boolean> {
    this.calls.push({ ...input });
    return input.response === this.acceptedResponse;
  }
}
