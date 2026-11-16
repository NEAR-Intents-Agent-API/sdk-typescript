import { grantSessionTokenPattern } from "./grants.js";
import type { GrantTokenExchangeResponse } from "./types.js";

/** A failed exchange is not repeated for this long: an outage costs one exchange, not one per call. */
const failureBackoffMs = 5_000;
/** A session this close to its end is treated as ended: a request would reach the API too late. */
const expiryGuardMs = 5_000;

type Session = { token: string; refreshAt: number; expiresAt: number };

/**
 * One grant session: exchanges lazily, keeps the `ngs_…` token and exchanges again shortly before
 * it ends. Concurrent callers share the exchange in flight. Between the refresh point and the end
 * of the session the current token keeps serving while one background exchange runs, so an
 * issuer outage in that window costs nothing; only a session that has ended waits for (and fails
 * with) an exchange. A failed exchange is not repeated for a few seconds.
 */
export class GrantSession {
  private current: Session | undefined;
  private pending: Promise<string> | undefined;
  private failure: { error: unknown; retryAt: number } | undefined;

  /**
   * @param exchange Runs one exchange with a fresh subject token.
   * @param refreshBeforeMs How long before the session ends to start exchanging again. The lead is
   *   at most half the session's own lifetime (a grant near its expiry can make it short), so
   *   renewal never starts before mid-life.
   */
  constructor(
    private readonly exchange: () => Promise<GrantTokenExchangeResponse>,
    private readonly refreshBeforeMs: number,
  ) {}

  token(): Promise<string> {
    const now = Date.now();
    const { current } = this;
    if (current && now < current.refreshAt) return Promise.resolve(current.token);
    if (current && now < current.expiresAt - expiryGuardMs) {
      // Still valid: refresh in the background and keep serving. A failure surfaces only once
      // the session has really ended.
      if (!this.pending && !this.backingOff(now)) void this.refresh().catch(() => undefined);
      return Promise.resolve(current.token);
    }
    if (this.pending) return this.pending;
    if (this.failure && this.backingOff(now)) return Promise.reject(this.failure.error);
    return this.refresh();
  }

  /**
   * Forgets `token` if it is still the current session, because the API refused it (the grant
   * behind it was revoked or replaced). The next call exchanges again. A newer session stays.
   */
  invalidate(token: string): void {
    if (this.current?.token === token) this.current = undefined;
  }

  private backingOff(now: number): boolean {
    return this.failure !== undefined && now < this.failure.retryAt;
  }

  /** The one exchange in flight, shared by every caller. */
  private refresh(): Promise<string> {
    this.pending ??= this.exchangeOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async exchangeOnce(): Promise<string> {
    // Counted from before the request and from `expires_in`, so neither network delay nor a
    // difference between this clock and the API's can make a stale token look fresh.
    const startedAt = Date.now();
    try {
      const { access_token: token, expires_in: expiresIn } = await this.exchange();
      if (!grantSessionTokenPattern.test(token))
        throw new Error("exchange did not return an ngs_ token");
      const lifetimeMs = expiresIn * 1000;
      this.current = {
        token,
        refreshAt: startedAt + lifetimeMs - Math.min(this.refreshBeforeMs, lifetimeMs / 2),
        expiresAt: startedAt + lifetimeMs,
      };
      this.failure = undefined;
      return token;
    } catch (error) {
      this.failure = { error, retryAt: Date.now() + failureBackoffMs };
      throw error;
    }
  }
}
