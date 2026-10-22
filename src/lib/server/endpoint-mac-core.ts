/**
 * Decide whether a container's MAC address may be carried to a replacement.
 *
 * Older daemons derive a bridge MAC from the container's IP (02:42 followed by the
 * four address octets). A recreate gives the replacement a new IP - the old container
 * still holds the old one while the new one is created - so carrying that MAC pins it
 * to an address it no longer matches, and once another container inherits the old IP
 * the two share a MAC on the bridge and roughly half the frames are misdelivered
 * (#1618).
 *
 * The MAC's own shape is what settles it. A derived MAC is recognisable from the
 * endpoint's IP alone, and it is also the only kind that can collide, since newer
 * daemons assign random addresses instead. So a MAC is dropped exactly when it spells
 * out the IP it was generated from; anything the user pinned is carried through.
 *
 * `Config.MacAddress` is not usable for this: daemons below API 1.44 omit the field
 * when the MAC was generated, and API 1.44+ omits it for every container, so its
 * absence carries no signal either way.
 */

/** The bits of a container inspect this decision needs. */
export interface MacInspectLike {
	Config?: { MacAddress?: string | null } | null;
}

/** An endpoint's settings as they appear in inspect / as sent on create. */
export interface EndpointLike {
	MacAddress?: string | null;
	IPAddress?: string | null;
	[key: string]: unknown;
}

function normalizeMac(mac: unknown): string | null {
	if (typeof mac !== 'string') return null;
	const trimmed = mac.trim();
	return trimmed === '' ? null : trimmed.toLowerCase();
}

/** The MAC Docker generates for `ip` on a bridge, or null if `ip` is not IPv4. */
export function macDerivedFromIp(ip: unknown): string | null {
	if (typeof ip !== 'string') return null;
	const octets = ip.trim().split('.');
	if (octets.length !== 4) return null;
	const hex: string[] = [];
	for (const octet of octets) {
		if (!/^\d{1,3}$/.test(octet)) return null;
		const value = Number(octet);
		if (value > 255) return null;
		hex.push(value.toString(16).padStart(2, '0'));
	}
	return `02:42:${hex.join(':')}`;
}

/**
 * True when the endpoint's MAC is the one Docker would have generated from its own IP,
 * i.e. an address the user never chose and that must not follow the container.
 */
export function isGeneratedEndpointMac(endpoint: EndpointLike | null | undefined): boolean {
	const mac = normalizeMac(endpoint?.MacAddress);
	if (mac === null) return false;
	return mac === macDerivedFromIp(endpoint?.IPAddress);
}

/**
 * The MAC to prefill an edit form with, or null when the container has none the user
 * chose. Never reports a generated address as if it were a setting.
 */
export function configuredMacAddress(
	inspect: MacInspectLike | null | undefined,
	endpoint?: EndpointLike | null
): string | null {
	const declared = normalizeMac(inspect?.Config?.MacAddress);
	if (declared !== null) return declared;
	if (!endpoint || isGeneratedEndpointMac(endpoint)) return null;
	return normalizeMac(endpoint.MacAddress);
}

/**
 * Copy of `endpoint` safe to send on create/connect: a MAC Docker derived from the old
 * IP is dropped so the replacement gets one matching its own address; a MAC the user
 * pinned is carried through.
 */
export function endpointWithoutGeneratedMac<T extends EndpointLike>(endpoint: T): T {
	const out = { ...endpoint };
	if (isGeneratedEndpointMac(endpoint)) delete out.MacAddress;
	return out;
}
