// Token bucket on an injected clock: up to `capacity` events at once, refilled continuously at
// `capacity` per `periodMs`. Per-isolate state; caps log volume, not a security control.

export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  #tokens: number;
  #updatedAt: number | null = null;

  constructor(capacity: number, periodMs: number) {
    if (!(capacity > 0 && periodMs > 0))
      throw new Error('TokenBucket: capacity and period must be > 0');
    this.#capacity = capacity;
    this.#refillPerMs = capacity / periodMs;
    this.#tokens = capacity;
  }

  /** Takes one token at time `now` (ms). A clock that goes backwards refills nothing. */
  take(now: number): boolean {
    if (this.#updatedAt !== null) {
      const elapsed = Math.max(0, now - this.#updatedAt);
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    }
    this.#updatedAt = this.#updatedAt === null ? now : Math.max(this.#updatedAt, now);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
