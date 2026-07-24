import { AppError } from "./errors.js";

interface Bucket {
  timestamps: number[];
  lastSeen: number;
}

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  take(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): void {
    const bucket = this.buckets.get(key) ?? { timestamps: [], lastSeen: now };
    bucket.timestamps = bucket.timestamps.filter(
      (timestamp) => timestamp > now - windowMs,
    );
    bucket.lastSeen = now;
    if (bucket.timestamps.length >= limit) {
      throw new AppError(
        "RATE_LIMITED",
        "操作过于频繁，请稍后再试。",
        429,
      );
    }
    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) {
      this.sweep(now);
    }
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeen < now - 10 * 60_000) {
        this.buckets.delete(key);
      }
    }
  }
}
