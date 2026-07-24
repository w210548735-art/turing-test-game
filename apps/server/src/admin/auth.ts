import { createHash, timingSafeEqual } from "node:crypto";
import { createAuditStamp, type AuditStamp } from "../risk/audit.js";

export type AdminRole = "REVIEWER" | "MODERATOR" | "SUPER_ADMIN";
export type AdminPermission =
  | "REPORT_READ"
  | "REPORT_DECIDE"
  | "BAN_ISSUE"
  | "BAN_REVOKE"
  | "AUDIT_READ";

export interface AdminPrincipal {
  id: string;
  role: AdminRole;
  tokenHash: string;
  active: boolean;
}

export interface AdminAuthentication {
  principal: Omit<AdminPrincipal, "tokenHash">;
  audit: AuditStamp;
}

const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<AdminPermission>> = {
  REVIEWER: new Set(["REPORT_READ"]),
  MODERATOR: new Set(["REPORT_READ", "REPORT_DECIDE", "BAN_ISSUE"]),
  SUPER_ADMIN: new Set([
    "REPORT_READ",
    "REPORT_DECIDE",
    "BAN_ISSUE",
    "BAN_REVOKE",
    "AUDIT_READ",
  ]),
};

export class AdminAuthError extends Error {
  constructor(
    public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "MISCONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
}

export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (
    leftBuffer.length !== 32 ||
    rightBuffer.length !== 32 ||
    leftBuffer.length !== rightBuffer.length
  ) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class AdminAuthenticator {
  constructor(private readonly principals: readonly AdminPrincipal[]) {
    if (
      principals.some(
        (principal) =>
          !/^[a-f0-9]{64}$/iu.test(principal.tokenHash) ||
          !principal.id.trim(),
      )
    ) {
      throw new AdminAuthError(
        "MISCONFIGURED",
        "Admin principal configuration is invalid",
      );
    }
  }

  authenticate(
    authorization: string | undefined,
    traceId?: string,
  ): AdminAuthentication {
    const match = authorization?.match(/^Bearer\s+(\S+)$/iu);
    if (!match?.[1]) {
      throw new AdminAuthError("UNAUTHORIZED", "Admin authentication required");
    }
    const presentedHash = hashBearerToken(match[1]);
    const principal = this.principals.find(
      (candidate) =>
        candidate.active && safeHashEqual(candidate.tokenHash, presentedHash),
    );
    if (!principal) {
      throw new AdminAuthError("UNAUTHORIZED", "Admin authentication failed");
    }
    return {
      principal: {
        id: principal.id,
        role: principal.role,
        active: principal.active,
      },
      audit: createAuditStamp({
        actorId: principal.id,
        ...(traceId ? { traceId } : {}),
      }),
    };
  }

  require(
    authentication: AdminAuthentication,
    permission: AdminPermission,
  ): void {
    if (!ROLE_PERMISSIONS[authentication.principal.role].has(permission)) {
      throw new AdminAuthError(
        "FORBIDDEN",
        "Admin permission is insufficient",
      );
    }
  }
}

export function principalsFromEnvironment(
  serialized = process.env.ADMIN_PRINCIPALS_JSON,
): AdminPrincipal[] {
  if (!serialized) return [];
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new AdminAuthError(
      "MISCONFIGURED",
      "ADMIN_PRINCIPALS_JSON is not valid JSON",
    );
  }
  if (!Array.isArray(value)) {
    throw new AdminAuthError(
      "MISCONFIGURED",
      "ADMIN_PRINCIPALS_JSON must be an array",
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new AdminAuthError(
        "MISCONFIGURED",
        "Admin principal entry is invalid",
      );
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      (record.role !== "REVIEWER" &&
        record.role !== "MODERATOR" &&
        record.role !== "SUPER_ADMIN") ||
      typeof record.tokenHash !== "string"
    ) {
      throw new AdminAuthError(
        "MISCONFIGURED",
        "Admin principal entry is invalid",
      );
    }
    return {
      id: record.id,
      role: record.role,
      tokenHash: record.tokenHash,
      active: record.active !== false,
    };
  });
}
