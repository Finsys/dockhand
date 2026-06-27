/**
 * Pure scanner override resolver (#1219).
 *
 * Decides which networkMode + DNS values to pass to the scanner container,
 * given (auto-detected, user-settings) inputs. Kept SvelteKit/server-free so
 * the unit tests can import it without triggering DB initialisation.
 */

export function resolveScannerOverrides(
	autoDetected: { networkMode?: string; extraHosts?: string[] },
	userSettings: { networkMode?: string; dns?: string[] }
): { networkMode?: string; dns?: string[]; extraHosts?: string[] } {
	const userNet = userSettings.networkMode?.trim();
	const networkMode = userNet ? userNet : autoDetected.networkMode || undefined;

	const cleanedDns = (userSettings.dns ?? [])
		.map((d) => d.trim())
		.filter((d) => d.length > 0);
	const dns = cleanedDns.length > 0 ? cleanedDns : undefined;

	const extraHosts =
		autoDetected.extraHosts && autoDetected.extraHosts.length > 0
			? autoDetected.extraHosts
			: undefined;

	return { networkMode, dns, extraHosts };
}
