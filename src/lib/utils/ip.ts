/**
 * Convert an IPv4 address (with optional CIDR) to a numeric value for sorting.
 * e.g. "192.168.1.0/24" -> 3232235776, "10.0.0.1" -> 167772161.
 * Returns Infinity for empty values or anything that is not IPv4 (IPv6 included) -
 * for mixed v4/v6 sorting use compareIps, which orders both families correctly.
 */
export function ipToNumber(ip: string | undefined | null): number {
	if (!ip || ip === '-') return Infinity; // Push empty IPs to the end
	// Strip CIDR notation if present
	const ipOnly = ip.split('/')[0];
	const parts = ipOnly.split('.');
	if (parts.length !== 4) return Infinity;
	return parts.reduce((acc, octet) => {
		const num = parseInt(octet, 10);
		return isNaN(num) ? Infinity : (acc << 8) + num;
	}, 0) >>> 0; // Convert to unsigned 32-bit
}

/**
 * Parse an IPv6 address (CIDR stripped) to its 128-bit value, or null if it is not
 * a valid IPv6 address. Handles `::` zero-compression and a trailing IPv4 tail
 * (e.g. `::ffff:192.168.0.1`).
 */
export function ipv6ToBigInt(ip: string): bigint | null {
	let s = ip.split('/')[0].trim();
	if (s === '' || !s.includes(':')) return null;

	// A trailing dotted-quad (IPv4-in-IPv6) becomes two hextets.
	const lastColon = s.lastIndexOf(':');
	const tail = s.slice(lastColon + 1);
	if (tail.includes('.')) {
		const o = tail.split('.');
		if (o.length !== 4) return null;
		const n = o.map((p) => parseInt(p, 10));
		if (n.some((x) => isNaN(x) || x < 0 || x > 255)) return null;
		const hi = ((n[0] << 8) | n[1]).toString(16);
		const lo = ((n[2] << 8) | n[3]).toString(16);
		s = s.slice(0, lastColon + 1) + hi + ':' + lo;
	}

	const halves = s.split('::');
	if (halves.length > 2) return null; // more than one '::' is invalid

	const parseGroups = (part: string): string[] | null => {
		if (part === '') return [];
		const g = part.split(':');
		for (const h of g) {
			if (h === '' || h.length > 4 || !/^[0-9a-fA-F]+$/.test(h)) return null;
		}
		return g;
	};

	const head = parseGroups(halves[0]);
	const rest = parseGroups(halves.length === 2 ? halves[1] : '');
	if (head === null || rest === null) return null;

	let groups: string[];
	if (halves.length === 2) {
		const fill = 8 - head.length - rest.length;
		if (fill < 0) return null;
		groups = [...head, ...Array(fill).fill('0'), ...rest];
	} else {
		groups = head;
	}
	if (groups.length !== 8) return null;

	let value = 0n;
	for (const h of groups) value = (value << 16n) + BigInt(parseInt(h, 16));
	return value;
}

/**
 * Comparator for IP strings (subnet/gateway/address, with or without CIDR) that
 * orders IPv4 and IPv6 correctly - IPv4 first, then IPv6, each numerically, with
 * empty/invalid values last. Fixes the "random" IPv6 subnet ordering (#1453) that
 * ipToNumber alone caused by collapsing every IPv6 value to Infinity.
 */
export function compareIps(a: string | undefined | null, b: string | undefined | null): number {
	const rank = (ip: string | undefined | null): { fam: number; val: bigint } => {
		if (!ip || ip === '-') return { fam: 2, val: 0n };
		const v4 = ipToNumber(ip);
		if (v4 !== Infinity) return { fam: 0, val: BigInt(v4) };
		const v6 = ipv6ToBigInt(ip);
		if (v6 !== null) return { fam: 1, val: v6 };
		return { fam: 2, val: 0n }; // unparseable -> last
	};
	const ra = rank(a);
	const rb = rank(b);
	if (ra.fam !== rb.fam) return ra.fam - rb.fam;
	return ra.val < rb.val ? -1 : ra.val > rb.val ? 1 : 0;
}
