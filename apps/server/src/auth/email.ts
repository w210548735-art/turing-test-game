import { AuthError } from "./errors.js";

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/**
 * 生成应用内唯一性比较使用的邮箱。
 * 不执行 Gmail 点号、加号别名等服务商特有改写，避免合并不同邮箱。
 */
export function canonicalizeEmail(input: unknown): string {
  if (typeof input !== "string") {
    throw new AuthError("INVALID_EMAIL", "邮箱必须是文本。");
  }
  const email = input.normalize("NFKC").trim().toLowerCase();
  const separator = email.lastIndexOf("@");
  const localPart = separator >= 0 ? email.slice(0, separator) : "";
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    localPart.length > MAX_LOCAL_PART_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new AuthError("INVALID_EMAIL", "邮箱格式无效。");
  }
  return email;
}
