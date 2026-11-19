/**
 * Replay guard for back-channel logout tokens, by jti.
 *
 * The spec says SHOULD-dedupe, not MUST: a replayed logout is idempotent (it deletes
 * sessions already gone), so a missed dedupe is harmless, which is why this is an
 * in-memory bound set rather than a DB table. The store is per-process: in a
 * multi-replica deploy a replay hitting another replica is not seen here, but the
 * logout itself is DB-shared and so still correct across replicas - only this
 * optimization is per-replica.
 */

/** How long a jti is remembered. A logout token is only interesting while sessions may still exist. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Hard cap so a flood of tokens cannot grow the set without bound. */
const DEFAULT_MAX = 2048;

export class JtiReplayGuard {
	private seen = new Map<string, number>(); // jti -> expiry epoch ms
	constructor(
		private ttlMs: number = DEFAULT_TTL_MS,
		private max: number = DEFAULT_MAX
	) {}

	/**
	 * Record a jti. Returns true if it was ALREADY seen (a replay), false if new.
	 * now is passed in so the behaviour is testable without a clock.
	 */
	markSeen(jti: string, now: number): boolean {
		this.evictExpired(now);
		const expiry = this.seen.get(jti);
		if (expiry !== undefined && expiry > now) return true;
		if (this.seen.size >= this.max) {
			// Drop the oldest-inserted entry (Map preserves insertion order).
			const oldest = this.seen.keys().next().value;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		this.seen.set(jti, now + this.ttlMs);
		return false;
	}

	/**
	 * Forget a jti recorded by markSeen. Used to roll back the reservation when the work
	 * the jti was claimed for (the session delete) fails, so the IdP's retry is not deduped
	 * away before the logout ever happened.
	 */
	unmark(jti: string): void {
		this.seen.delete(jti);
	}

	private evictExpired(now: number): void {
		for (const [jti, expiry] of this.seen) {
			if (expiry <= now) this.seen.delete(jti);
		}
	}
}
