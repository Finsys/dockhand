/**
 * Re-scope a container's per-network settings when its primary network changes.
 *
 * Aliases, static addresses, MAC and gateway priority belong to ONE network. Carrying
 * the old primary's values onto a different network fails outright - compose service
 * aliases applied to the default bridge come back as "invalid endpoint settings".
 *
 * The new primary is often one of the extras the container is already on, and then its
 * own settings are the ones that survive: createContainer builds the primary endpoint
 * from the `network*` fields and skips the extras entry whose name equals the primary,
 * so a static address held on that network is lost unless it is handed over here.
 *
 * Pure, so the rules can be tested without a daemon.
 */

/** One endpoint's settings, as extractContainerOptions reports them. */
export interface EndpointConfig {
	ipv4Address?: string;
	ipv6Address?: string;
	aliases?: string[];
}

/** The subset of container options this decision reads and rewrites. */
export interface NetworkScopedOptions {
	networkAliases?: string[];
	networkIpv4Address?: string;
	networkIpv6Address?: string;
	networkGwPriority?: number;
	macAddress?: string;
	additionalNetworks?: string[];
	networkConfigs?: Record<string, EndpointConfig>;
}

/**
 * The options a recreate should use once `newPrimary` becomes the primary network.
 *
 * `incoming` is the request's own options, when it carries any. The primary endpoint is
 * built from the `network*` fields and the extras entry for the primary is skipped, so a
 * caller that edits the new primary's address the same way it edits any other network -
 * through `networkConfigs`, which is all the edit form sends - would otherwise have that
 * edit overwritten by the value read from the container. The caller's entry therefore
 * wins, and its absence means cleared rather than "use the old one".
 *
 * Returns a new object; the input is left alone. `gwPriority` and the MAC are always
 * dropped - a priority is meaningless against a different set of attachments, and a
 * carried MAC collides once another container inherits the old address.
 */
export function rescopeForPrimarySwitch<T extends NetworkScopedOptions>(
	options: T,
	newPrimary: string,
	incoming?: Pick<NetworkScopedOptions, 'networkConfigs'>
): T & NetworkScopedOptions {
	const promoted = incoming?.networkConfigs
		? incoming.networkConfigs[newPrimary]
		: options.networkConfigs?.[newPrimary];

	const next: T & NetworkScopedOptions = {
		...options,
		networkAliases: promoted?.aliases,
		networkIpv4Address: promoted?.ipv4Address,
		networkIpv6Address: promoted?.ipv6Address,
		networkGwPriority: undefined,
		macAddress: undefined
	};

	// The old primary was never in these, so removing the new primary leaves exactly
	// the networks that remain extras.
	if (options.additionalNetworks) {
		next.additionalNetworks = options.additionalNetworks.filter((n) => n !== newPrimary);
	}
	if (options.networkConfigs) {
		const { [newPrimary]: _promoted, ...rest } = options.networkConfigs;
		next.networkConfigs = rest;
	}

	return next;
}
