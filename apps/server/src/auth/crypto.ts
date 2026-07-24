import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/** 只把原始令牌交给调用方；持久化层只能接收其摘要。 */
export function createOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
