import { randomUUID } from "node:crypto";

export interface AuditContext {
  actorId: string;
  traceId?: string;
  ipHash?: string;
  userAgentHash?: string;
}

export interface AuditStamp {
  eventId: string;
  actorId: string;
  traceId: string;
  occurredAt: string;
  ipHash?: string;
  userAgentHash?: string;
}

export function createAuditStamp(
  context: AuditContext,
  now = new Date(),
): AuditStamp {
  return {
    eventId: randomUUID(),
    actorId: context.actorId,
    traceId: context.traceId ?? randomUUID(),
    occurredAt: now.toISOString(),
    ...(context.ipHash ? { ipHash: context.ipHash } : {}),
    ...(context.userAgentHash
      ? { userAgentHash: context.userAgentHash }
      : {}),
  };
}
