/**
 * Registry auth handshake results (challenge + token) shared across requests, so a batch
 * of checks against one repository does one handshake instead of one per image and per
 * call. Keyed by registry base URL, scope and a hash of the credentials; failures are never
 * stored, and concurrent lookups for one key share a single handshake.
 */
import { createHash } from 'node:crypto';

/** A handshake result; ttlMs 0 means do not store it. */
export interface AuthOutcome {
	header: string | null;
	ttlMs: number;
}

/** Token lifetime the distribution spec assumes when a registry sends no expires_in. */
const DEFAULT_TOKEN_TTL_MS = 60_000;
/** Dropped from every token lifetime so a token is never sent at the edge of expiry. */
const EXPIRY_MARGIN_MS = 10_000;
/** Basic auth or no auth: nothing expires, but the registry's answer is rechecked now and then. */
export const NO_TOKEN_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

/** How long a bearer token may be reused, from the token response's expires_in (seconds). */
export function bearerTtlMs(expiresIn: unknown): number {
	const lifetime = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TOKEN_TTL_MS;
	return Math.max(0, lifetime - EXPIRY_MARGIN_MS);
}

export function authCacheKey(
	baseUrl: string,
	scope: string,
	credentials: { username: string; password: string } | null | undefined
): string {
	const who = credentials
		? createHash('sha256').update(JSON.stringify([credentials.username, credentials.password])).digest('hex').slice(0, 32)
		: 'anonymous';
	return `${baseUrl}|${scope}|${who}`;
}

interface Flight {
	promise: Promise<string | null>;
	controller: AbortController;
	/** Waiters that brought their own signal and have not given up yet. */
	waiters: number;
	/** A waiter without a signal is waiting, so the handshake must run to its own deadline. */
	pinned: boolean;
}

export function createAuthCache(now: () => number = Date.now, maxEntries = DEFAULT_MAX_ENTRIES) {
	const entries = new Map<string, { header: string | null; expiresAt: number }>();
	const inflight = new Map<string, Flight>();

	/**
	 * Wait for a shared handshake under the caller's own signal: an abort rejects only this
	 * caller, and the handshake is cancelled once every waiter with a signal has given up
	 * and none without one is waiting.
	 */
	function join(key: string, flight: Flight, signal?: AbortSignal): Promise<string | null> {
		if (!signal) {
			flight.pinned = true;
			return flight.promise;
		}
		if (signal.aborted) return Promise.reject(signal.reason);
		flight.waiters++;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				reject(signal.reason);
				if (--flight.waiters === 0 && !flight.pinned) {
					if (inflight.get(key) === flight) inflight.delete(key);
					flight.controller.abort(signal.reason);
				}
			};
			signal.addEventListener('abort', onAbort, { once: true });
			flight.promise.then(
				(value) => {
					signal.removeEventListener('abort', onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener('abort', onAbort);
					reject(error);
				}
			);
		});
	}

	return {
		/**
		 * The cached header for `key`, or the result of `handshake`. The handshake gets a
		 * signal owned by the cache, never a caller's, so one caller giving up does not fail
		 * the others waiting on it; `signal` bounds only this caller's wait.
		 */
		get(key: string, handshake: (signal: AbortSignal) => Promise<AuthOutcome>, signal?: AbortSignal): Promise<string | null> {
			const hit = entries.get(key);
			if (hit && hit.expiresAt > now()) return Promise.resolve(hit.header);
			if (hit) entries.delete(key);
			let flight = inflight.get(key);
			if (!flight) {
				const controller = new AbortController();
				const started: Flight = { promise: Promise.resolve(null), controller, waiters: 0, pinned: false };
				started.promise = handshake(controller.signal)
					.then((outcome) => {
						if (outcome.ttlMs > 0 && !controller.signal.aborted) {
							if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
							entries.set(key, { header: outcome.header, expiresAt: now() + outcome.ttlMs });
						}
						return outcome.header;
					})
					.finally(() => {
						if (inflight.get(key) === started) inflight.delete(key);
					});
				// A cancelled flight with nobody left to observe it must not surface as unhandled.
				started.promise.catch(() => {});
				inflight.set(key, started);
				flight = started;
			}
			return join(key, flight, signal);
		},
		/**
		 * Drop entries a registry rejected: every entry holding `header`, or when no header
		 * was sent, the stored "no auth needed" answers for `host`.
		 */
		forget(header: string | null, host?: string): void {
			for (const [key, entry] of entries) {
				const rejected = header
					? entry.header === header
					: entry.header === null && host !== undefined && key.includes(`://${host}|`);
				if (rejected) entries.delete(key);
			}
		},
		clear(): void {
			entries.clear();
		},
		size(): number {
			return entries.size;
		}
	};
}

export const registryAuthCache = createAuthCache();

/**
 * Call when a request to `host` came back 401: drops the header it carried, or, when it
 * carried none, the stored answer that said none was needed.
 */
export function forgetRegistryAuth(header: string | null | undefined, host: string): void {
	registryAuthCache.forget(header ?? null, host);
}
