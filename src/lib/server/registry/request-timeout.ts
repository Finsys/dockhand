/**
 * The per-request timeout for registry calls made by an update check, so a registry
 * that accepts the connection and never answers cannot stall the check waiting on it.
 */

/** `REGISTRY_REQUEST_TIMEOUT` in whole seconds (1-600); unset or anything else is 10 s. */
export function registryRequestTimeoutMs(value: string | undefined): number {
	const seconds = Number(value);
	return Number.isInteger(seconds) && seconds >= 1 && seconds <= 600 ? seconds * 1000 : 10_000;
}

export const REGISTRY_REQUEST_TIMEOUT_MS = registryRequestTimeoutMs(process.env.REGISTRY_REQUEST_TIMEOUT);

/** A fresh timeout for one request, combined with the caller's cancellation when given. */
export function registryRequestSignal(signal?: AbortSignal, timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
