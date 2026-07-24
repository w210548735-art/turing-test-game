const DEFAULT_NAMESPACE = "turing";

function safeSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 所有 Redis key 都从这里生成，避免不同模块使用不一致的命名和过期策略。
 */
export class RedisKeys {
  constructor(private readonly namespace = DEFAULT_NAMESPACE) {}

  healthProbe(): string {
    return `${this.namespace}:health`;
  }

  admissionQueue(): string {
    return `${this.namespace}:admission:queue`;
  }

  admissionTicket(userId: string): string {
    return `${this.namespace}:admission:ticket:${safeSegment(userId)}`;
  }

  admissionLock(): string {
    return `${this.namespace}:lock:admission`;
  }

  aiHistory(): string {
    return `${this.namespace}:matchmaking:ai-history`;
  }

  wsTicket(ticket: string): string {
    return `${this.namespace}:ws-ticket:${safeSegment(ticket)}`;
  }

  roomSnapshot(roomId: string): string {
    return `${this.namespace}:room:${safeSegment(roomId)}:snapshot`;
  }

  roomMessages(roomId: string): string {
    return `${this.namespace}:room:${safeSegment(roomId)}:messages`;
  }

  roomSequence(roomId: string): string {
    return `${this.namespace}:room:${safeSegment(roomId)}:sequence`;
  }

  roomLock(roomId: string): string {
    return `${this.namespace}:lock:room:${safeSegment(roomId)}`;
  }
}
