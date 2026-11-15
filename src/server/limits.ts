export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private readonly capacity: number;
  private readonly perSecond: number;

  constructor(capacity: number, perSecond: number) {
    this.tokens = capacity;
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.updatedAt = performance.now();
  }

  take(amount = 1): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.perSecond / 1000);
    this.updatedAt = now;
    if (amount > this.tokens) return false;
    this.tokens -= amount;
    return true;
  }
}

export class IpLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; seen: number }>();
  private readonly capacity: number;
  private readonly perSecond: number;

  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
  }

  take(address: string): boolean {
    const now = Date.now();
    let entry = this.buckets.get(address);
    if (!entry) {
      if (this.buckets.size >= 4096) {
        for (const [key, value] of this.buckets) {
          if (now - value.seen > 120_000) this.buckets.delete(key);
        }
        if (this.buckets.size >= 4096) return false;
      }
      entry = { bucket: new TokenBucket(this.capacity, this.perSecond), seen: now };
      this.buckets.set(address, entry);
    }
    entry.seen = now;
    return entry.bucket.take();
  }
}