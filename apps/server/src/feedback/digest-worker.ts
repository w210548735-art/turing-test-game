import { randomUUID } from "node:crypto";
import type {
  FeedbackEmailDelivery,
  FeedbackRepositoryPort,
} from "./types.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
const TEN_AM_UTC_HOUR = 2;

export function latestBeijingTenAmCutoff(now: Date): Date {
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  let cutoff = new Date(
    Date.UTC(
      beijing.getUTCFullYear(),
      beijing.getUTCMonth(),
      beijing.getUTCDate(),
      TEN_AM_UTC_HOUR,
    ),
  );
  if (cutoff > now) {
    cutoff = new Date(cutoff.getTime() - 24 * 60 * 60_000);
  }
  return cutoff;
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 6));
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** exponent);
}

export interface FeedbackDigestWorkerOptions {
  repository: FeedbackRepositoryPort;
  delivery: FeedbackEmailDelivery;
  recipientEmail: string;
  now?: () => Date;
  leaseOwner?: string;
  leaseMs?: number;
  intervalMs?: number;
  onFailure?: (digestId: string, errorName: string) => void;
}

export class FeedbackDigestWorker {
  readonly #now: () => Date;
  readonly #leaseOwner: string;
  readonly #leaseMs: number;
  readonly #intervalMs: number;
  #timer?: NodeJS.Timeout;
  #running?: Promise<void>;

  constructor(private readonly options: FeedbackDigestWorkerOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#leaseOwner = options.leaseOwner ?? randomUUID();
    this.#leaseMs = options.leaseMs ?? 2 * 60_000;
    this.#intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => void this.runSafely(),
      this.#intervalMs,
    );
    this.#timer.unref();
    void this.runSafely();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async runOnce(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.execute().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  private async execute(): Promise<void> {
    const now = this.#now();
    const digest = await this.options.repository.claimDigest({
      cutoffAt: latestBeijingTenAmCutoff(now),
      now,
      leaseOwner: this.#leaseOwner,
      leaseMs: this.#leaseMs,
    });
    if (!digest) return;
    try {
      await this.options.delivery.sendFeedbackDigest({
        to: this.options.recipientEmail,
        digest,
      });
      await this.options.repository.markDigestSent(
        digest.id,
        this.#leaseOwner,
        this.#now(),
      );
    } catch (error) {
      const failedAt = this.#now();
      const errorName =
        error instanceof Error ? error.name : "UnknownError";
      await this.options.repository.markDigestFailed(
        digest.id,
        this.#leaseOwner,
        new Date(
          failedAt.getTime() + retryDelayMs(digest.attemptCount),
        ),
        errorName,
      );
      this.options.onFailure?.(digest.id, errorName);
    }
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      const errorName =
        error instanceof Error ? error.name : "UnknownError";
      this.options.onFailure?.("unclaimed", errorName);
    }
  }
}
