export type AuthErrorCode =
  | "INVALID_EMAIL"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "WEAK_PASSWORD"
  | "EMAIL_ALREADY_EXISTS"
  | "INVALID_TOKEN_TTL"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_CONSUMED"
  | "INVALID_SESSION_TTL"
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "DEVICE_INVALID"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_RESTRICTED"
  | "SESSION_NOT_FOUND";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
