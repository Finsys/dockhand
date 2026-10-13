/**
 * Decide whether two references point at the same Docker/Podman network.
 *
 * Podman exposes one network under two names: a container's inspect reports the default
 * bridge as `podman`, while `GET /networks` and `HostConfig.NetworkMode` call it
 * `bridge`. Both carry the SAME id. Comparing names therefore treats the primary network
 * as an extra one, which shows it under "Additional networks" and makes an edit re-attach
 * a network the container is already on (`403 network is already connected`) (#1619).
 *
 * Ids settle it when both sides have one; otherwise the name is all there is, which is
 * the pre-existing behaviour and is correct on Docker, where the two never disagree.
 */

/** A network as the container inspect or the network list reports it. */
export interface NetworkRef {
	name: string;
	/** Absent on older API versions, and on a name-only reference. */
	id?: string | null;
}

function normalizeId(id: unknown): string | null {
	return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** True when both refs are the same network, by id when known and by name otherwise. */
export function isSameNetwork(a: NetworkRef, b: NetworkRef): boolean {
	const idA = normalizeId(a.id);
	const idB = normalizeId(b.id);
	if (idA && idB) return idA === idB;
	return a.name === b.name;
}

/**
 * Whether `netName` (a key of the inspect's Networks map) is the container's primary
 * network, given `HostConfig.NetworkMode` and the full set of attached network names.
 *
 * Matching on the name alone misses Podman, which calls the default bridge "podman" in
 * the inspect and "bridge" in NetworkMode - the primary is then never found and its
 * aliases and static IPs are dropped on the next save (#1619). A container attached to
 * exactly one network is on its primary whatever that network is called, which settles
 * the alias without needing the network list. With several attachments there is nothing
 * to infer from, so only the names are compared.
 */
export function isPrimaryNetworkName(
	netName: string,
	networkMode: string,
	attachedNames: readonly string[]
): boolean {
	if (netName === networkMode) return true;
	if (networkMode === 'bridge' && (netName === 'bridge' || netName === 'default')) return true;
	return attachedNames.length === 1 && attachedNames[0] === netName;
}

/** The per-network settings a recreate has to carry over for one endpoint. */
export interface EndpointSettings {
	aliases?: string[];
	ipv4Address?: string;
	ipv6Address?: string;
}

/**
 * The user-meaningful settings of one endpoint, as the inspect reports it.
 *
 * Docker seeds every endpoint with the container's own id and short id as aliases; those
 * are its bookkeeping, not something to send back on create, so they are dropped. An
 * endpoint with nothing left to say returns null, which keeps the caller's map free of
 * empty entries.
 */
export function endpointSettingsFromInspect(
	endpoint: { Aliases?: string[] | null; DNSNames?: string[] | null; IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null } | null | undefined,
	containerId: string
): EndpointSettings | null {
	if (!endpoint) return null;
	const shortId = containerId.substring(0, 12);
	const raw = (endpoint.Aliases?.length ? endpoint.Aliases : endpoint.DNSNames) || [];
	const aliases = raw.filter((a) => a !== containerId && a !== shortId);

	const settings: EndpointSettings = {};
	if (aliases.length > 0) settings.aliases = aliases;
	if (endpoint.IPAMConfig?.IPv4Address) settings.ipv4Address = endpoint.IPAMConfig.IPv4Address;
	if (endpoint.IPAMConfig?.IPv6Address) settings.ipv6Address = endpoint.IPAMConfig.IPv6Address;
	return Object.keys(settings).length > 0 ? settings : null;
}

/**
 * The networks a container is attached to BESIDES its primary one.
 *
 * `attached` comes from the container inspect (name plus the id the daemon reported);
 * `primaryName` is `HostConfig.NetworkMode`, a bare name. `known` is the network list,
 * when the caller has it: it supplies the primary's id so a Podman alias still matches.
 */
export function additionalNetworkNames(
	attached: NetworkRef[],
	primaryName: string,
	known: NetworkRef[] = []
): string[] {
	const primary: NetworkRef = {
		name: primaryName,
		id: known.find((n) => n.name === primaryName)?.id ?? null
	};
	return attached.filter((net) => !isSameNetwork(net, primary)).map((net) => net.name);
}

/** Everything a recreate needs to know about a container's network attachments. */
export interface MappedNetworks {
	/** The primary endpoint's aliases, or undefined when it has none worth sending. */
	primaryAliases?: string[];
	primaryIpv4Address?: string;
	primaryIpv6Address?: string;
	primaryGwPriority?: number;
	/** The endpoint object the primary was read from, for the caller's MAC decision. */
	primaryEndpoint?: unknown;
	/** Attachments other than the primary, in inspect order. */
	additionalNetworks: string[];
	/** Per-network settings for those extras, keyed by network name. */
	networkConfigs: Record<string, EndpointSettings>;
}

/** One network's entry under NetworkSettings.Networks in a container inspect. */
type InspectEndpoint = {
	Aliases?: string[] | null;
	DNSNames?: string[] | null;
	IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null;
	GwPriority?: number;
} | null;

/**
 * Split a container's attachments into its primary endpoint and the extras.
 *
 * The extras are what a recreate has to reconnect: without them an update that does not
 * name the networks itself drops every secondary attachment, because there is nothing in
 * the existing options to preserve them from.
 *
 * Both "bridge" and "default" answer to NetworkMode "bridge", so the FIRST match wins the
 * primary and any later one is treated as an extra - otherwise it would overwrite the
 * primary's aliases and IPs with its own.
 */
export function mapContainerNetworks(
	networks: Record<string, unknown>,
	networkMode: string,
	containerId: string,
	compose?: { project?: string; service?: string }
): MappedNetworks {
	const attachedNames = Object.keys(networks ?? {});
	const out: MappedNetworks = { additionalNetworks: [], networkConfigs: {} };
	let primarySeen = false;

	for (const [netName, netConfig] of Object.entries(networks ?? {})) {
		const endpoint = netConfig as InspectEndpoint;

		if (primarySeen || !isPrimaryNetworkName(netName, networkMode, attachedNames)) {
			out.additionalNetworks.push(netName);
			const settings = endpointSettingsFromInspect(endpoint, containerId);
			if (settings) out.networkConfigs[netName] = settings;
			continue;
		}

		primarySeen = true;
		assignPrimary(out, endpoint, containerId, compose);
	}

	return out;
}

/** Fill in the primary half of the result from its endpoint. */
function assignPrimary(
	out: MappedNetworks,
	endpoint: InspectEndpoint,
	containerId: string,
	compose?: { project?: string; service?: string }
): void {
	out.primaryEndpoint = endpoint;

	const settings = endpointSettingsFromInspect(endpoint, containerId);
	const aliases = composeAliases(settings?.aliases, compose);

	if (aliases.length > 0) out.primaryAliases = aliases;
	if (settings?.ipv4Address) out.primaryIpv4Address = settings.ipv4Address;
	if (settings?.ipv6Address) out.primaryIpv6Address = settings.ipv6Address;
	if (endpoint?.GwPriority) out.primaryGwPriority = endpoint.GwPriority;
}

/**
 * A compose container is reached by its service name and project-service name; the
 * daemon does not always list both, so make sure a recreate keeps them.
 */
function composeAliases(
	existing: string[] | undefined,
	compose?: { project?: string; service?: string }
): string[] {
	const aliases = existing ? [...existing] : [];
	if (!compose?.project || !compose?.service) return aliases;

	for (const alias of [compose.service, `${compose.project}-${compose.service}`]) {
		if (!aliases.includes(alias)) aliases.push(alias);
	}
	return aliases;
}
