import { endpointForRecreate, type EndpointLike } from './endpoint-mac-core';

/**
 * Which network names and options the update sidecar may be told about.
 *
 * The sidecar reconnects the replacement container to the networks the old one was
 * on, and it reads them from its environment into an unquoted shell expansion.
 * Naming a network is a permission of its own, so the person who chose a name need
 * not be the administrator who later runs the update - and Docker accepts almost
 * anything as a name, including `a;id;b`.
 */

/**
 * Docker's own name grammar. A name may open with `_` or `.` as well as an
 * alphanumeric - the daemon accepts those - but never with `-`, which the daemon
 * refuses and which would reach the CLI as a flag.
 */
const SAFE_NETWORK_NAME = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

/**
 * An address or alias, which must survive an unquoted expansion as one word. A leading
 * colon is allowed because an IPv6 address may start with one; a leading dash is not,
 * because docker would read it as a flag.
 */
const SAFE_OPTION_VALUE = /^[a-zA-Z0-9:][a-zA-Z0-9_.:-]*$/;

export function isSafeNetworkName(name: unknown): name is string {
	return typeof name === 'string' && name.length <= 256 && SAFE_NETWORK_NAME.test(name);
}

export interface NetworkEnvPlan {
	/** The env var lines for the sidecar. Empty when there is nothing to reconnect. */
	envVars: string[];
	/** Names withheld, so the caller can say so rather than reconnecting silently. */
	skipped: string[];
}

/**
 * The NETWORKS and NETWORK_OPTS_* lines for a container's networks.
 *
 * Anything that is not plainly a name or a value is dropped rather than escaped:
 * coming back on one fewer network is a smaller failure than a name reaching a shell.
 */
export function planNetworkEnvVars(
	networks: Record<string, unknown> | null | undefined
): NetworkEnvPlan {
	const names: string[] = [];
	const optionLines: string[] = [];
	const skipped: string[] = [];

	for (const [netName, netConfig] of Object.entries(networks || {})) {
		if (!isSafeNetworkName(netName)) {
			skipped.push(String(netName));
			continue;
		}
		names.push(netName);

		const nc = (netConfig || {}) as {
			IPAMConfig?: { IPv4Address?: string; IPv6Address?: string };
			Aliases?: unknown[];
			Links?: unknown[];
		};
		const safe = (v: unknown) => typeof v === 'string' && SAFE_OPTION_VALUE.test(v);
		const opts: string[] = [];

		if (safe(nc.IPAMConfig?.IPv4Address)) opts.push(`--ip ${nc.IPAMConfig!.IPv4Address}`);
		if (safe(nc.IPAMConfig?.IPv6Address)) opts.push(`--ip6 ${nc.IPAMConfig!.IPv6Address}`);
		for (const alias of nc.Aliases || []) if (safe(alias)) opts.push(`--alias ${alias}`);
		for (const link of nc.Links || []) if (safe(link)) opts.push(`--link ${link}`);

		if (opts.length > 0) {
			optionLines.push(`NETWORK_OPTS_${netName.replace(/[.-]/g, '_')}=${opts.join(' ')}`);
		}
	}

	if (names.length === 0) return { envVars: [], skipped };
	return { envVars: [`NETWORKS=${names.join(' ')}`, ...optionLines], skipped };
}

interface SelfInspectLike {
	HostConfig?: { NetworkMode?: string | null } | null;
	NetworkSettings?: { Networks?: Record<string, EndpointLike> | null } | null;
}

/**
 * Puts the primary network on `createConfig` when its endpoint pins an IP, and returns
 * the sidecar's reconnect plan for the other networks. Without a pinned IP nothing
 * changes and every network stays with the sidecar.
 *
 * `docker network connect` does not apply `--ip` on the network already named in
 * HostConfig.NetworkMode and has no MAC option, so both only survive when given at
 * create. The daemon reserves a static IP at start, and the sidecar starts the new
 * container after removing the old one.
 */
export function applySelfUpdateNetworks(
	createConfig: Record<string, unknown>,
	inspect: SelfInspectLike | null | undefined
): { primary: string | null; reconnect: NetworkEnvPlan } {
	const networks: Record<string, EndpointLike> = { ...inspect?.NetworkSettings?.Networks };
	const mode = inspect?.HostConfig?.NetworkMode;
	const shared = !mode || mode === 'host' || mode === 'none' || mode.startsWith('container:') || mode.startsWith('service:');
	let primary: string | null = null;
	if (!shared) primary = mode === 'default' ? 'bridge' : mode;
	const endpoint = primary ? networks[primary] : undefined;
	const ipam = endpoint?.IPAMConfig;
	if (!primary || !endpoint || (!ipam?.IPv4Address && !ipam?.IPv6Address)) {
		return { primary: null, reconnect: planNetworkEnvVars(networks) };
	}

	const settings: Record<string, unknown> = { IPAMConfig: ipam };
	if (Array.isArray(endpoint.Aliases) && endpoint.Aliases.length > 0) settings.Aliases = endpoint.Aliases;
	if (Array.isArray(endpoint.Links) && endpoint.Links.length > 0) settings.Links = endpoint.Links;
	const mac = endpointForRecreate(endpoint).MacAddress;
	if (mac) settings.MacAddress = mac;
	createConfig.NetworkingConfig = { EndpointsConfig: { [primary]: settings } };

	delete networks[primary];
	return { primary, reconnect: planNetworkEnvVars(networks) };
}
