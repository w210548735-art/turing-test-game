import { AuthError } from "./errors.js";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "111111111111",
  "abcdefghijkl",
  "password1234",
  "password12345",
  "qwertyuiop12",
  "qwerty123456",
  "admin12345678",
  "letmein123456",
  "iloveyou12345",
]);

/**
 * Argon2id 等具体实现由基础设施层提供，接口保持异步以避免阻塞事件循环。
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

function isSimpleSequence(value: string): boolean {
  const normalized = value.toLowerCase();
  const sequences = [
    "0123456789",
    "1234567890",
    "abcdefghijklmnopqrstuvwxyz",
    "qwertyuiopasdfghjklzxcvbnm",
  ];
  return sequences.some(
    (sequence) =>
      sequence.includes(normalized) ||
      sequence.split("").reverse().join("").includes(normalized),
  );
}

export function validatePassword(
  input: unknown,
  canonicalEmail?: string,
): string {
  if (typeof input !== "string") {
    throw new AuthError("WEAK_PASSWORD", "密码必须是文本。");
  }
  const length = [...input].length;
  if (length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      "PASSWORD_TOO_SHORT",
      `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`,
    );
  }
  if (length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(
      "PASSWORD_TOO_LONG",
      `密码最多允许 ${MAX_PASSWORD_LENGTH} 个字符。`,
    );
  }

  const normalized = input.normalize("NFKC").toLowerCase();
  const localPart = canonicalEmail?.split("@", 1)[0]?.toLowerCase();
  const isRepeated = /^(.)\1+$/u.test(normalized);
  if (
    COMMON_PASSWORDS.has(normalized) ||
    isRepeated ||
    isSimpleSequence(normalized) ||
    (localPart !== undefined &&
      localPart.length >= 4 &&
      normalized.includes(localPart))
  ) {
    throw new AuthError("WEAK_PASSWORD", "密码过于常见或容易猜测。");
  }
  return input;
}
