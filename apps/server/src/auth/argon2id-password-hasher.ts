import argon2 from "argon2";
import type { PasswordHasher } from "./password.js";

export interface Argon2idPasswordHasherOptions {
  readonly memoryCostKiB?: number;
  readonly timeCost?: number;
  readonly parallelism?: number;
  readonly hashLength?: number;
}

/**
 * 生产密码哈希适配器。argon2 包使用原生异步工作线程执行计算，
 * 避免在 Node.js 主事件循环中同步计算密码哈希。
 */
export class Argon2idPasswordHasher implements PasswordHasher {
  readonly #options: Required<Argon2idPasswordHasherOptions>;

  constructor(options: Argon2idPasswordHasherOptions = {}) {
    this.#options = {
      memoryCostKiB: options.memoryCostKiB ?? 19_456,
      timeCost: options.timeCost ?? 2,
      parallelism: options.parallelism ?? 1,
      hashLength: options.hashLength ?? 32,
    };
    if (
      this.#options.memoryCostKiB < 8 * this.#options.parallelism ||
      this.#options.timeCost < 1 ||
      this.#options.parallelism < 1 ||
      this.#options.hashLength < 16
    ) {
      throw new TypeError("Argon2id 参数不满足最低安全约束");
    }
  }

  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.#options.memoryCostKiB,
      timeCost: this.#options.timeCost,
      parallelism: this.#options.parallelism,
      hashLength: this.#options.hashLength,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      // 哈希损坏与密码错误对调用方统一表现为认证失败。
      return false;
    }
  }
}
