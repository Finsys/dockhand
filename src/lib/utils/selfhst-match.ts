// Pure image-name -> selfh.st reference matcher. Conservative by design: a
// confident hit returns the reference, anything uncertain returns null so the UI
// keeps its generic icon (never a wrong logo; the namespace fallback knowingly shows
// the vendor logo). Memoized per (image, name) pair so a list of 100 containers costs one
// lookup per unique pair, not per render.

/**
 * Aliases ONLY for cases where the Docker image basename differs from the selfh.st
 * Reference. An image whose basename already IS a known reference (redis, grafana,
 * sonarr, ...) needs no entry - resolveBase() falls back to an exact match. Keep this
 * small and high-confidence. There is deliberately no fuzzy/substring fallback (it
 * mis-badges, e.g. `redis-exporter` -> `redis`).
 */
const IMAGE_ALIASES: Record<string, string> = {
	'pms-docker': 'plex',
	'plexinc': 'plex',
	'homeassistant': 'home-assistant',
	'hass': 'home-assistant',
	'pihole': 'pi-hole',
	'adguardhome': 'adguard-home',
	'portainer-ce': 'portainer',
	'portainer-ee': 'portainer',
	'qbittorrentvpn': 'qbittorrent',
	'postgres': 'postgresql',
	'mongo': 'mongodb',
	vmalert: 'victoriametrics',
	vmagent: 'victoriametrics'
};

/**
 * Reduce a full image reference to its lowercase basename, dropping registry
 * host, namespace, tag and digest. `lscr.io/linuxserver/sonarr:latest` -> `sonarr`.
 */
export function imageBasename(image: string): string {
	let s = (image || '').trim().toLowerCase();
	if (!s) return '';
	// strip digest, then tag
	s = s.split('@')[0];
	const lastColon = s.lastIndexOf(':');
	const lastSlash = s.lastIndexOf('/');
	if (lastColon > lastSlash) s = s.slice(0, lastColon);
	// basename after the last slash
	s = s.slice(lastSlash + 1);
	return s;
}

/**
 * Namespaces that republish other projects' images, so their name says nothing about
 * the app inside (`linuxserver/sonarr` is Sonarr, not LinuxServer).
 */
const DISTRIBUTOR_NAMESPACES = new Set([
	'library',
	'linuxserver',
	'bitnami',
	'hotio',
	'binhex',
	'jlesage',
	'11notes',
	'ubuntu',
	'debian',
	'centos',
	'fedora',
	'alpine',
	'rockylinux',
	'almalinux',
	'opensuse',
	'archlinux',
	'kalilinux',
	'nixos',
	'gentoo',
	'amazonlinux',
	'oraclelinux',
	'redhat'
]);

/**
 * The image's namespace for a plain `namespace/name` path (after an optional registry
 * host), or '' otherwise. Deeper paths are ambiguous (org vs a mirror/proxy project like
 * `harbor.corp/docker/grafana/promtail`), so they get none. Registry host rule is Docker's:
 * a first segment containing `.` or `:`, or `localhost`.
 * `victoriametrics/vmalert` -> `victoriametrics`, `linuxserver/sonarr` -> ''.
 */
export function imageNamespace(image: string): string {
	const parts = (image || '').trim().toLowerCase().split('@')[0].split('/');
	if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) parts.shift();
	if (parts.length !== 2 || DISTRIBUTOR_NAMESPACES.has(parts[0])) return '';
	return parts[0];
}

/** Drop separators so `thelounge` can match the reference `the-lounge`. */
function stripSeparators(s: string): string {
	return s.replace(/[-_]/g, '');
}

/**
 * A base is matched to a reference by: alias table, exact match, then a
 * separator-insensitive match (image basenames drop the hyphens the selfh.st
 * Reference keeps, e.g. `thelounge` -> `the-lounge`, `homeassistant` -> `home-assistant`).
 * The separator match is equality-after-normalization, NOT a substring/fuzzy guess, so it
 * never mis-badges (`redisexporter` has no reference and stays unmatched); the real
 * manifest has zero refs that collapse to the same separator-stripped key, so the map is
 * unambiguous. `separatorless` is prebuilt from knownRefs so the lookup stays O(1).
 */
function resolveBase(
	base: string,
	knownRefs: Set<string>,
	separatorless: Map<string, string>
): string | null {
	if (!base) return null;
	const alias = IMAGE_ALIASES[base];
	if (alias && knownRefs.has(alias)) return alias;
	if (knownRefs.has(base)) return base;
	const stripped = stripSeparators(base);
	if (!stripped) return null; // an all-separator base ("---") must not match a "" key
	const collapsed = separatorless.get(stripped);
	if (collapsed) return collapsed;
	return null;
}

/** Build the separator-stripped -> reference lookup for a manifest's reference set. */
function buildSeparatorlessMap(knownRefs: Set<string>): Map<string, string> {
	const map = new Map<string, string>();
	for (const ref of knownRefs) map.set(stripSeparators(ref), ref);
	return map;
}

/** Match a Docker image reference to a selfh.st Reference (by its basename). */
export function matchSelfhstRef(
	image: string,
	knownRefs: Set<string>,
	separatorless: Map<string, string> = buildSeparatorlessMap(knownRefs)
): string | null {
	return resolveBase(imageBasename(image), knownRefs, separatorless);
}

/**
 * Normalize a container name to a candidate reference: drop a leading slash and the
 * compose replica suffix (`-1` / `_1`), lowercase. `/immich_server_1` -> `immich_server`,
 * `/traefik-1` -> `traefik`.
 */
export function containerNameBase(name: string): string {
	let s = (name || '').trim().toLowerCase();
	if (!s) return '';
	if (s.startsWith('/')) s = s.slice(1);
	// compose appends a numeric replica index: web-1, db_1
	s = s.replace(/[-_]\d+$/, '');
	return s;
}

/**
 * Fallback match by CONTAINER NAME when the image did not resolve (e.g. an image pinned
 * by digest with no readable tag). Same confidence bar as the image path: alias table,
 * then exact name == reference. No fuzzy guessing - a generic name like `web` or `app`
 * that isn't a known reference stays unmatched.
 */
export function matchSelfhstByName(
	name: string,
	knownRefs: Set<string>,
	separatorless: Map<string, string> = buildSeparatorlessMap(knownRefs)
): string | null {
	return resolveBase(containerNameBase(name), knownRefs, separatorless);
}

/**
 * Last-resort match on a `namespace/name` image, in two steps.
 *
 * First the vendor-qualified name (`apache/superset` -> `apache-superset`), which is how
 * selfh.st names an app whose vendor publishes several. Only if that misses does the bare
 * namespace count, and then only when the vendor looks like a single-product one: a
 * namespace that also publishes OTHER apps would paint every one of them with the same
 * vendor logo, and the matcher's whole contract is never to show a wrong one.
 */
export function matchSelfhstByNamespace(
	image: string,
	knownRefs: Set<string>,
	separatorless: Map<string, string> = buildSeparatorlessMap(knownRefs)
): string | null {
	const ns = imageNamespace(image);
	if (!ns) return null;

	const qualified = resolveBase(`${ns}-${imageBasename(image)}`, knownRefs, separatorless);
	if (qualified) return qualified;

	if (!imageIsTheVendor(ns, image)) return null;
	return resolveBase(ns, knownRefs, separatorless);
}

/**
 * Whether the image IS the vendor's own product rather than one of several it publishes.
 *
 * True when the image name is the vendor's name or grows out of it -
 * `home-assistant/home-assistant`, `victoriametrics/victoria-logs`, `nixos/nix`. False for
 * `elastic/filebeat` or `mailu/postfix`, where the vendor logo would say nothing about
 * the container and would be the same for every one of its siblings.
 */
function imageIsTheVendor(ns: string, image: string): boolean {
	const bare = (v: string) => v.replace(/[^a-z0-9]/g, '');
	const vendor = bare(ns);
	const app = bare(imageBasename(image));
	if (!vendor || !app) return false;

	// One is the other, or one grows out of it: home-assistant/home-assistant,
	// victoriametrics/victoria-logs, nixos/nix.
	if (app.startsWith(vendor) || vendor.startsWith(app)) return true;

	// Or they share enough of a beginning to be the same brand. Four letters is the
	// line that lets victoriametrics/vmalert through while keeping mailu/postfix and
	// elastic/filebeat out, where the image names nothing the vendor is called.
	return sharedPrefix(vendor, app) >= 4;
}

/** How many letters two names begin with in common. */
function sharedPrefix(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let n = 0;
	while (n < max && a[n] === b[n]) n++;
	return n;
}


/**
 * Build a memoized matcher bound to a manifest's reference set. Resolves by image first
 * (authoritative), then the container name, then the image namespace.
 * Memoized per (image, name) pair so a list of 100 containers costs one lookup per unique
 * pair, not per render.
 */
export function createSelfhstMatcher(
	knownRefs: Set<string>
): (image: string, name?: string) => string | null {
	const cache = new Map<string, string | null>();
	const separatorless = buildSeparatorlessMap(knownRefs);
	return (image: string, name = '') => {
		const key = `${image} ${name}`;
		if (cache.has(key)) return cache.get(key)!;
		const ref =
			matchSelfhstRef(image, knownRefs, separatorless) ??
			matchSelfhstByName(name, knownRefs, separatorless) ??
			matchSelfhstByNamespace(image, knownRefs, separatorless);
		cache.set(key, ref);
		return ref;
	};
}
