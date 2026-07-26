export type AccountStatus =
  | "PENDING_EMAIL"
  | "ACTIVE"
  | "LIMITED"
  | "SUSPENDED"
  | "BANNED"
  | "DELETED";
export type AccountRole = "PLAYER" | "ROOT";

export interface AuthUser {
  id: string;
  emailOriginal: string;
  emailCanonical: string;
  passwordHash: string;
  playerNumber: number;
  displayName: string;
  nickname: string;
  typingStatus: string;
  status: AccountStatus;
  role: AccountRole;
  emailVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type VerificationTokenPurpose =
  | "EMAIL_VERIFICATION"
  | "PASSWORD_RESET"
  | "EMAIL_CHANGE"
  | "WEBSOCKET_TICKET";

export interface VerificationTokenRecord {
  id: string;
  subjectId: string;
  purpose: VerificationTokenPurpose;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  revokedAt?: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  deviceId?: string;
  ipRiskKey?: string;
  userAgentSummary?: string;
  revokedAt?: Date;
}

export interface DeviceRecord {
  id: string;
  tokenHash: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  trusted: boolean;
  riskScore: number;
  userIds: string[];
}
