/**
 * Podman is inconsistent about the default bridge: `/networks` lists it as
 * `bridge` and `HostConfig.NetworkMode` accepts that name, but the
 * `EndpointsConfig` key does not - a create keyed by `bridge` fails with
 * "unable to find network with name or ID bridge: network not found" (#1619).
 * Container inspect calls the same network `podman`, so the two halves of the
 * API disagree and nothing in the network payload reveals which name to use.
 *
 * The network id is accepted as a key by both engines, so the create is retried
 * with it - but only after the name has been refused, because Docker echoes the
 * id back as the inspect key and keying by id up front would leave ids where the
 * UI expects network names.
 */

/**
 * Whether a create failure is worth retrying by network id.
 *
 * This is a cheap PRE-FILTER, not the decision: Podman reports a genuinely
 * missing network with the same wording, so a user's typo matches too. What
 * actually separates the two is looking the network up - it resolves for the
 * aliased bridge and 404s for a name that does not exist. Keep both; dropping
 * the lookup would retry typos, and dropping its null-tolerance would replace a
 * clear "network not found" with an opaque inspect error.
 */
export function isUnknownNetworkKeyError(message: string | undefined | null): boolean {
	if (typeof message !== 'string') return false;
	return /unable to find network with name or ID/i.test(message);
}

/**
 * The key to retry the create with, or null to rethrow the original error.
 *
 * `networkId` is what the daemon returned for the refused key, or null when the
 * lookup failed - which is the case that must NOT retry, since it means the
 * network genuinely does not exist.
 */
export function retryEndpointKey(args: {
	message: string | undefined | null;
	endpoints: Record<string, unknown> | undefined;
	key: string;
	networkId: string | null | undefined;
}): string | null {
	const { message, endpoints, key, networkId } = args;
	if (!key || !endpoints?.[key]) return null;
	if (!isUnknownNetworkKeyError(message)) return null;
	// No id means the lookup 404'd: the name was refused because it is not a
	// network, not because Podman knows it under another name.
	if (!networkId || networkId === key) return null;
	return networkId;
}
