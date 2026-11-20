/**
 * Which endpoint settings Docker accepts per network, and under which key a recreate
 * should address the primary endpoint.
 *
 * Two Docker rules drive this module:
 *
 * 1. A static IP (`IPAMConfig`) and network-scoped aliases only exist on user-defined
 *    networks. Sending either for the built-in `bridge` (or `default`, `host`, `none`,
 *    `container:*`, `service:*`) fails the whole recreate with
 *    "invalid endpoint settings: user-specified IP address is supported on user-defined
 *    networks only".
 *
 * 2. `HostConfig.NetworkMode` is not always the name of the endpoint the inspect reports.
 *    Podman calls the default bridge `podman` in the inspect and `bridge` in NetworkMode
 *    (#1619), and a container whose bridge attachment was disconnected keeps NetworkMode
 *    `bridge` while its only attachment is a user-defined network. Keying the create by
 *    the mode then puts that network's static IP and aliases onto `bridge` - rule 1.
 */

/** Endpoint settings as the callers hold them (form values, inspect fields). */
export interface NetworkEndpointSettings {
	aliases?: string[];
	ipv4Address?: string;
	ipv6Address?: string;
	gwPriority?: number;
}

/** The subset of Docker's EndpointSettings this project ever sends on create/connect. */
export interface DockerEndpointConfig {
	Aliases?: string[];
	IPAMConfig?: { IPv4Address?: string; IPv6Address?: string };
	GwPriority?: number;
}

const BUILT_IN_NETWORKS = new Set(['bridge', 'default', 'host', 'none']);

/** True when the name is a real, user-defined network rather than a built-in mode. */
export function networkIsUserDefined(name: string | null | undefined): boolean {
	const trimmed = (name ?? '').trim();
	if (!trimmed || BUILT_IN_NETWORKS.has(trimmed)) return false;
	if (trimmed.startsWith('container:') || trimmed.startsWith('service:')) return false;
	return true;
}

/**
 * The endpoint config to send for `name`, with everything Docker rejects for a built-in
 * network dropped. An empty object means "attach with the network defaults".
 */
export function endpointConfigForNetwork(
	name: string | null | undefined,
	settings: NetworkEndpointSettings = {}
): DockerEndpointConfig {
	const config: DockerEndpointConfig = {};
	if (!networkIsUserDefined(name)) return config;

	if (settings.aliases && settings.aliases.length > 0) {
		config.Aliases = settings.aliases;
	}
	if (settings.ipv4Address || settings.ipv6Address) {
		config.IPAMConfig = {};
		if (settings.ipv4Address) config.IPAMConfig.IPv4Address = settings.ipv4Address;
		if (settings.ipv6Address) config.IPAMConfig.IPv6Address = settings.ipv6Address;
	}
	if (settings.gwPriority !== undefined) {
		config.GwPriority = settings.gwPriority;
	}
	return config;
}

/**
 * The network key a create request should use for the primary endpoint.
 *
 * `bridge`/`default` are modes, not necessarily the attached network's name. When the
 * container has exactly one attachment and it is a real network under another name, that
 * name is the endpoint the inspect described - key the create by it, so its static IP
 * and aliases land on the network they belong to (#1619 and the edit-modal recreate).
 * Shared modes and named networks are already their own key.
 */
export function primaryNetworkKey(
	networkMode: string | null | undefined,
	attachedNames: readonly string[]
): string {
	const mode = (networkMode ?? '').trim() || 'bridge';
	if (mode !== 'bridge' && mode !== 'default') return mode;

	if (attachedNames.length === 1) {
		const only = attachedNames[0];
		if (only && only !== 'bridge' && only !== 'default') return only;
	}
	return mode;
}
