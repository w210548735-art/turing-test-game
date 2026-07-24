import type { RiskSignal } from "./types.js";

export interface RiskSignalRepository {
  add(signal: RiskSignal): void;
  list(subjectKey: string, now: Date): readonly RiskSignal[];
  removeExpired(now: Date): number;
}

/**
 * Demo 使用的内存仓储。读取与写入均复制对象，避免调用方修改仓储状态；
 * 超出保留时间的信号会在读取时清理。
 */
export class DecayingMemoryRiskSignalRepository
  implements RiskSignalRepository
{
  readonly #signals = new Map<string, RiskSignal[]>();

  constructor(private readonly retentionMs: number) {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new TypeError("风险信号保留时间必须大于 0");
    }
  }

  add(signal: RiskSignal): void {
    if (
      !signal.id ||
      !signal.subjectKey ||
      !signal.type ||
      !Number.isFinite(signal.weight) ||
      signal.weight <= 0 ||
      Number.isNaN(signal.occurredAt.getTime())
    ) {
      throw new TypeError("风险信号不合法");
    }
    const existing = this.#signals.get(signal.subjectKey) ?? [];
    existing.push(cloneSignal(signal));
    this.#signals.set(signal.subjectKey, existing);
  }

  list(subjectKey: string, now: Date): readonly RiskSignal[] {
    assertDate(now);
    this.removeExpired(now);
    return (this.#signals.get(subjectKey) ?? []).map(cloneSignal);
  }

  removeExpired(now: Date): number {
    assertDate(now);
    const cutoff = now.getTime() - this.retentionMs;
    let removed = 0;
    for (const [subjectKey, signals] of this.#signals) {
      const active = signals.filter((signal) => {
        const keep = signal.occurredAt.getTime() >= cutoff;
        if (!keep) removed += 1;
        return keep;
      });
      if (active.length > 0) this.#signals.set(subjectKey, active);
      else this.#signals.delete(subjectKey);
    }
    return removed;
  }
}

function cloneSignal(signal: RiskSignal): RiskSignal {
  return {
    ...signal,
    occurredAt: new Date(signal.occurredAt),
  };
}

function assertDate(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("时间不合法");
  }
}
