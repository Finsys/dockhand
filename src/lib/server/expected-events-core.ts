/**
 * Suppresses the die/kill/stop notifications that an auto-update deliberately
 * causes. When Dockhand recreates a container to update its image, it stops the
 * old container - Docker then emits kill/die/stop events that are EXPECTED, not a
 * crash, but they used to notify the user as "Container died" (#68).
 *
 * A container id is marked "expected" for a short window before the update stops
 * it; the event handler checks this and skips the notification for the noisy
 * lifecycle actions only. A genuine crash AFTER the window still alarms. Pure,
 * in-memory, unit-tested - no timers, expiry is checked lazily against `now`.
 */

/** Actions an auto-update legitimately triggers, whose notification is noise. */
const SUPPRESSED_ACTIONS = new Set(['die', 'kill', 'stop']);

export class ExpectedEventsTracker {
	// containerId -> expiry epoch-ms. Kept small: entries are dropped on check.
	private readonly expiry = new Map<string, number>();

	/** Mark a container's imminent stop/kill as expected for `ttlMs` from `now`. */
	markExpected(containerId: string, now: number, ttlMs: number): void {
		if (!containerId) return;
		this.expiry.set(containerId, now + ttlMs);
	}

	/**
	 * True when this action for this container should NOT notify: it is a
	 * die/kill/stop for a container marked expected and still within its window.
	 * A non-suppressed action (start, oom, health) always returns false, so those
	 * still notify even mid-update. Expired/unknown ids return false.
	 */
	shouldSuppress(containerId: string, action: string, now: number): boolean {
		// Opportunistically drop everything already past its window so happy-path
		// entries (whose id never emits another event to lazily expire them) can't
		// accumulate for the process lifetime. Cheap: the map holds at most a handful
		// of in-flight updates at once.
		this.prune(now);
		if (!SUPPRESSED_ACTIONS.has(action)) return false;
		const exp = this.expiry.get(containerId);
		if (exp === undefined) return false;
		// A single update legitimately emits die AND kill AND stop for the same id, so
		// do NOT delete on a suppressed hit (that would let the 2nd/3rd through); the
		// prune above reclaims the entry once its window passes.
		return now <= exp;
	}

	/** Clear a container's mark, e.g. when an update rolls back and restarts it so a
	 *  later genuine crash of that restored container is NOT wrongly suppressed. */
	clear(containerId: string): void {
		this.expiry.delete(containerId);
	}

	/** Drop all entries whose window has passed (called opportunistically). */
	prune(now: number): void {
		for (const [id, exp] of this.expiry) {
			if (now > exp) this.expiry.delete(id);
		}
	}

	/** Test/introspection helper. */
	size(): number {
		return this.expiry.size;
	}
}

/** How long after marking a container its expected stop/kill stays suppressed. */
export const EXPECTED_EVENT_TTL_MS = 30_000;

/**
 * Process-wide shared tracker. docker.ts marks a container before an auto-update
 * stops it; subprocess-manager.ts checks it before notifying. Kept in this
 * import-light module so neither of those (which don't import each other) creates
 * a cycle - same pattern as token-cache.ts.
 */
export const expectedEvents = new ExpectedEventsTracker();
