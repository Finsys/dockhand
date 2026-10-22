/**
 * Whether percentage disk warnings can work on a host.
 *
 * The percentage mode needs a total to divide by, and takes it from `/info`
 * `DriverStatus` -> `Data Space Total`. Only the devicemapper driver reports that
 * key; overlay2 keeps images on an ordinary filesystem and has no pool of its own,
 * so there is nothing to report. Without the key the check has no denominator and
 * silently does nothing, which looks exactly like "measured, all fine" (#1631).
 *
 * Asked of the same field the metrics path reads, so the answer the UI shows and
 * the behaviour at collection time cannot disagree.
 */

/** The `DriverStatus` key holding the storage pool size. */
export const POOL_SIZE_KEY = 'Data Space Total';

type DriverStatus = unknown;

/**
 * The pool size in bytes, or 0 when the value is not one the collector can divide by.
 *
 * The same shape the collector accepts, so a value it would reject - "0 B", "unknown",
 * a unit nobody parses - is not reported here as a working denominator.
 */
export function poolSizeBytes(value: unknown): number {
	if (typeof value !== 'string') return 0;
	// Matched without trimming first, because the collector does not trim either: a
	// padded value it would reject must not be reported here as a working denominator.
	const match = value.match(/^([\d.]+)\s*([KMGT]?B)$/i);
	if (!match) return 0;
	const units: Record<string, number> = {
		B: 1,
		KB: 1024,
		MB: 1024 ** 2,
		GB: 1024 ** 3,
		TB: 1024 ** 4
	};
	return parseFloat(match[1]) * (units[match[2].toUpperCase()] || 1);
}

/**
 * Whether this host reports a pool size, so percentage warnings would fire.
 *
 * `null` means unknown - the host could not be asked. That is deliberately not
 * `false`: a momentary outage must not present itself as an unsupported host.
 */
export function supportsPercentageWarnings(driverStatus: DriverStatus): boolean | null {
	if (driverStatus == null) return null;
	if (!Array.isArray(driverStatus)) return null;

	for (const entry of driverStatus) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [key, value] = entry;
		if (key !== POOL_SIZE_KEY) continue;
		// A size the collector cannot divide by is the same as absent.
		return poolSizeBytes(value) > 0;
	}
	return false;
}

/**
 * Whether the percentage option should be unselectable.
 *
 * Only on a host that definitely cannot use it, and only when it is not the mode the
 * environment already has. Reading the STORED mode rather than the form's current value
 * is what keeps the escape hatch open: gating on the live value would disable the option
 * the moment somebody switched away, trapping them in their own click.
 */
export function percentageOptionDisabled(
	percentageSupported: boolean | null | undefined,
	storedMode: string | null | undefined
): boolean {
	return percentageSupported === false && storedMode !== 'percentage';
}
