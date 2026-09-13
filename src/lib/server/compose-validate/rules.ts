/**
 * Compose Validate rule catalog (plugin model).
 *
 * Each rule is a self-contained RuleDefinition: { id, description, group,
 * defaultSeverity, check }. The engine (index.ts) runs each rule, stamps the effective
 * severity (default OR user override), and isolates a crashing rule. A rule's `check`
 * returns findings WITHOUT severity (the engine fills it) unless the rule is
 * intrinsically graded, in which case it sets its own and the engine respects it.
 *
 * ADDING A RULE: write one RuleDefinition and push it into RULES below. That's it -
 * the id auto-appears in the settings UI and the config accepts disable/severity for it.
 */

import type { RuleDefinition, RuleFinding, ParsedCompose } from './types';
import { SERVICE_KEYS, TOP_LEVEL_KEYS, isLikelyTypo } from './vocab';

// --- small readers over the plain-object compose --------------------------------

function services(p: ParsedCompose): Record<string, Record<string, unknown>> {
	const s = p.doc?.services;
	return s && typeof s === 'object' && !Array.isArray(s)
		? (s as Record<string, Record<string, unknown>>)
		: {};
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function ports(svc: Record<string, unknown>): unknown[] {
	return Array.isArray(svc.ports) ? svc.ports : [];
}

/**
 * Parse a compose port entry into { hostIp, hostPort }. Handles the short string
 * form ("8080:80", "127.0.0.1:8080:80", "8080", "8080-8090:80"), and the long
 * object form ({ published, target, host_ip }). Returns null when there's no host
 * publish (e.g. a bare container port with no mapping).
 */
export function parsePortEntry(
	entry: unknown
): { hostIp: string | null; hostPort: number | null; raw: string } | null {
	if (typeof entry === 'number') return { hostIp: null, hostPort: null, raw: String(entry) };
	if (typeof entry === 'string') {
		const raw = entry;
		// Bracketed IPv6 host ip: "[::1]:8080:80" / "[::]:8080:80". Split off the bracket
		// first so the ':' inside the address doesn't break the field split.
		const v6 = /^\[([0-9a-fA-F:]+)\]:(.+)$/.exec(entry);
		if (v6) {
			const rest = v6[2].split(':'); // host[:container]
			return { hostIp: v6[1], hostPort: toPort(rest[0]), raw };
		}
		const parts = entry.split(':');
		if (parts.length === 1) return { hostIp: null, hostPort: null, raw }; // "80" - not published
		if (parts.length === 2) return { hostIp: null, hostPort: toPort(parts[0]), raw };
		return { hostIp: parts[0] || null, hostPort: toPort(parts[1]), raw }; // ip:host:container
	}
	const obj = asRecord(entry);
	if (obj) {
		const raw = JSON.stringify(obj);
		const published = obj.published;
		const hostPort =
			typeof published === 'number'
				? published
				: typeof published === 'string'
					? toPort(published)
					: null;
		return { hostIp: typeof obj.host_ip === 'string' ? obj.host_ip : null, hostPort, raw };
	}
	return null;
}

function toPort(s: string): number | null {
	const first = s.split('-')[0].trim();
	const n = Number(first);
	return Number.isInteger(n) && n > 0 ? n : null;
}

const DB_CACHE_IMAGE =
	/(?:^|\/)(postgres|mysql|mariadb|mongo|redis|memcached|rabbitmq|elasticsearch|clickhouse|cassandra|couchdb|influxdb)(?::|$)/i;

// Admin / management UIs that expose control over data or the host. Broadly
// published (0.0.0.0) these are worse than a password-protected datastore: many
// ship with a default or no login. Kept DISJOINT from DB_CACHE_IMAGE so a given
// service produces at most one exposure finding (datastore=warn, panel=error).
const ADMIN_PANEL_IMAGE =
	/(?:^|\/)(adminer|phpmyadmin|pgadmin\d?|portainer(?:-ce|-ee)?|cloudbeaver|mongo-express|redis-?commander|dpage\/pgadmin\d?)(?::|$)/i;

// Env-var NAMES that look like a secret (matched case-insensitively as a whole word part).
// Secret-looking env NAMES. Anchored on word/underscore boundaries so a secret word
// must be a whole segment (matches DB_PASSWORD, API_KEY; not TOKENIZED, PASSWORD_POLICY-
// style substrings). Plural credentials allowed.
const SECRET_NAME =
	/(^|[_-])(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credentials?)([_-]|$)/i;
// `*_FILE` / `*_PATH` name a file to READ the secret from - that's the SAFE pattern
// (Docker/compose secrets), so don't flag those even if the name contains "password".
const SECRET_FILE_REF = /(_file|_path)$/i;

// Dockhand's own image (any registry prefix / tag). A stack deploying Dockhand
// legitimately needs the Docker socket, so the socket-mount rule treats it as
// info, not a misconfiguration.
const DOCKHAND_IMAGE = /(?:^|\/)(?:fin?sys\/)?dockhand(?::|$)/i;

// Host paths that must never be bind-mounted writable - a rw mount here = own the host.
const SENSITIVE_HOST_ROOTS = ['/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/var', '/root'];

// Linux capabilities that approach privileged.
const DANGEROUS_CAPS = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_READ_SEARCH']);

/**
 * Iterate a service `environment:` as [key, value, index] regardless of the two forms:
 * a mapping ({KEY: val}) or a list of "KEY=val" strings. `value` is null when absent
 * (list entry with no '=', or mapping value null). `index` is the list position for
 * lineOf, or the key for the mapping form.
 */
function envEntries(svc: Record<string, unknown>): { key: string; value: string | null; at: string | number }[] {
	const env = svc.environment;
	const out: { key: string; value: string | null; at: string | number }[] = [];
	if (Array.isArray(env)) {
		env.forEach((e, i) => {
			if (typeof e !== 'string') return;
			const eq = e.indexOf('=');
			out.push(eq === -1 ? { key: e, value: null, at: i } : { key: e.slice(0, eq), value: e.slice(eq + 1), at: i });
		});
	} else {
		const rec = asRecord(env);
		if (rec) for (const [k, v] of Object.entries(rec)) out.push({ key: k, value: v == null ? null : String(v), at: k });
	}
	return out;
}

// A short-form volume's option field is the last ':'-segment, a comma list
// ("ro", "ro,z", "z,ro", "rw"). Read-only if it contains the `ro` option.
function optsAreReadonly(optField: string): boolean {
	return optField.split(',').some((o) => o.trim() === 'ro');
}

/** The bind SOURCE (host side) of a volume entry, short or long form; null if not a bind. */
function bindSource(v: unknown): { source: string; readonly: boolean } | null {
	if (typeof v === 'string') {
		const parts = v.split(':');
		if (parts.length < 2) return null; // anonymous volume, not a bind
		const source = parts[0];
		if (!source.startsWith('/') && !source.startsWith('.') && !source.startsWith('~')) return null; // named volume
		// The option field only exists when there are 3+ segments (src:dst:opts).
		return { source, readonly: parts.length >= 3 && optsAreReadonly(parts[parts.length - 1]) };
	}
	const o = asRecord(v);
	if (o?.type === 'bind' && typeof o.source === 'string') {
		return { source: o.source, readonly: o.read_only === true };
	}
	return null;
}

// --- Docker socket-proxy classifier (adapted from sencho #1791) ------------------
//
// A well-configured docker-socket-proxy sidecar is intentional, not a footgun, so
// it must not be flagged like a direct socket mount. These pure helpers read the
// RAW parsed compose (we have no rendered effective model in this linter), so
// per-network `internal:` is read literally from the top-level networks: block.

const SOCKET_PROXY_IMAGE_HINTS = [
	'tecnativa/docker-socket-proxy',
	'lscr.io/linuxserver/socket-proxy',
	'docker-socket-proxy'
];

// docker-socket-proxy API-group env flags. A group is "enabled" only when its
// rendered value is exactly `1` (proxy convention); key presence alone is not.
const PROXY_API_FLAGS = new Set([
	'CONTAINERS', 'IMAGES', 'INFO', 'EVENTS', 'NETWORKS', 'VOLUMES', 'SERVICES',
	'TASKS', 'NODES', 'SECRETS', 'CONFIGS', 'SWARM', 'SYSTEM', 'BUILD', 'COMMIT',
	'DISTRIBUTION', 'EXEC', 'PING', 'PLUGINS', 'SESSION', 'POST', 'DELETE'
]);
const MUTATING_PROXY_API_FLAGS = new Set(['POST', 'DELETE']);

/** All docker.sock bind mounts of a service (short or long form). */
function socketBinds(svc: Record<string, unknown>): { readonly: boolean }[] {
	const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
	const out: { readonly: boolean }[] = [];
	for (const v of vols) {
		const src = typeof v === 'string' ? v : asRecord(v)?.source;
		if (typeof src === 'string' && src.includes('docker.sock')) {
			const raw = typeof v === 'string' ? v : '';
			const parts = raw.split(':');
			const readonly =
				(parts.length >= 3 && optsAreReadonly(parts[parts.length - 1])) ||
				asRecord(v)?.read_only === true;
			out.push({ readonly });
		}
	}
	return out;
}

function mountsDockerSocket(svc: Record<string, unknown>): boolean {
	return socketBinds(svc).length > 0;
}

/** The enabled proxy API-group flag NAMES (value exactly `1`). */
function enabledProxyApiFlags(svc: Record<string, unknown>): string[] {
	return envEntries(svc)
		.filter((e) => PROXY_API_FLAGS.has(e.key.toUpperCase()) && e.value?.trim() === '1')
		.map((e) => e.key.toUpperCase());
}

function hasSocketProxyImage(svc: Record<string, unknown>): boolean {
	const image = typeof svc.image === 'string' ? svc.image.toLowerCase() : '';
	return SOCKET_PROXY_IMAGE_HINTS.some((h) => image.includes(h));
}

function hasSocketProxyNameHint(name: string, svc: Record<string, unknown>): boolean {
	const cn = typeof svc.container_name === 'string' ? svc.container_name : '';
	return `${name} ${cn}`.toLowerCase().replace(/[_.]/g, '-').includes('socket-proxy');
}

/**
 * Is this service a dedicated Docker socket proxy? A known image is an artifact
 * identity, so it stands alone. A service NAME is author-controlled free text, so
 * it only counts with an observable fact (a read-only socket, or >=1 enabled API
 * flag). With neither name nor image hint, require both. Prefer false negatives:
 * a miss keeps the high direct-mount finding.
 */
function isSocketProxyService(name: string, svc: Record<string, unknown>): boolean {
	if (!mountsDockerSocket(svc)) return false;
	if (hasSocketProxyImage(svc)) return true;
	const readOnly = socketBinds(svc).some((b) => b.readonly);
	const apiKeyCount = enabledProxyApiFlags(svc).length;
	if (hasSocketProxyNameHint(name, svc)) return readOnly || apiKeyCount >= 1;
	return readOnly && apiKeyCount >= 2;
}

/** The service NAMES that are classified socket proxies in this compose. */
function socketProxyNames(p: ParsedCompose): string[] {
	return Object.entries(services(p))
		.filter(([name, svc]) => isSocketProxyService(name, svc))
		.map(([name]) => name);
}

/** Network keys a service is attached to (array or map form); empty = implicit default. */
function serviceNetworkKeys(svc: Record<string, unknown>): string[] {
	const nets = svc.networks;
	if (Array.isArray(nets)) return nets.filter((n): n is string => typeof n === 'string');
	const rec = asRecord(nets);
	return rec ? Object.keys(rec) : [];
}

/**
 * True unless EVERY network the proxy joins is declared `internal: true` in the
 * top-level networks: block. No membership -> implicit default network (not
 * internal). A network the file does not describe cannot be shown internal.
 * NOTE: reads the LITERAL source networks: block, not a merged/extends model.
 */
function proxyAttachesNonInternalNetwork(p: ParsedCompose, svc: Record<string, unknown>): boolean {
	const keys = serviceNetworkKeys(svc);
	if (keys.length === 0) return true;
	const topNets = asRecord(p.doc?.networks) ?? {};
	return keys.some((k) => asRecord(topNets[k])?.internal !== true);
}

/** tcp:// hosts a service points its Docker client at (DOCKER_HOST env + tcp in command). */
function dockerEndpointHosts(svc: Record<string, unknown>): string[] {
	const hosts: string[] = [];
	for (const e of envEntries(svc)) {
		if (e.key.toUpperCase() === 'DOCKER_HOST' && e.value) {
			const m = /tcp:\/\/([^:/\s]+)/i.exec(e.value);
			if (m) hosts.push(m[1].toLowerCase());
		}
	}
	const cmd = svc.command;
	const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
	for (const m of cmdStr.matchAll(/tcp:\/\/([^:/\s]+)/gi)) hosts.push(m[1].toLowerCase());
	return hosts;
}

/** Names a dependent could use to reach this proxy on a shared network. */
function proxyReachableNames(name: string, svc: Record<string, unknown>): string[] {
	const out = [name.toLowerCase()];
	if (typeof svc.container_name === 'string') out.push(svc.container_name.toLowerCase());
	// network aliases (map form: networks: { net: { aliases: [...] } })
	const rec = asRecord(svc.networks);
	if (rec) {
		for (const membership of Object.values(rec)) {
			const aliases = asRecord(membership)?.aliases;
			if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string') out.push(a.toLowerCase());
		}
	}
	return out;
}

// --- rule catalog ---------------------------------------------------------------

export const RULES: RuleDefinition[] = [
	{
		id: 'NO_SERVICES',
		description: 'The compose file defines no services',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p) {
			if (!p.doc) return [];
			if (Object.keys(services(p)).length === 0) {
				return [
					{
						ruleId: 'NO_SERVICES',
						message: 'No services defined - the compose file will deploy nothing',
						hint: 'Add a `services:` block, or check for a typo in the key.',
						line: p.lineOf(['services'])
					}
				];
			}
			return [];
		}
	},
	{
		id: 'DUPLICATE_HOST_PORT',
		description: 'Two services in this stack publish the same host port',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p) {
			const out: RuleFinding[] = [];
			const seen = new Map<number, string>();
			for (const [name, svc] of Object.entries(services(p))) {
				for (let i = 0; i < ports(svc).length; i++) {
					const parsed = parsePortEntry(ports(svc)[i]);
					if (!parsed?.hostPort) continue;
					const prev = seen.get(parsed.hostPort);
					if (prev && prev !== name) {
						out.push({
							ruleId: 'DUPLICATE_HOST_PORT',
							service: name,
							message: `Host port ${parsed.hostPort} is already published by service "${prev}"`,
							hint: 'Two services cannot bind the same host port; change one.',
							line: p.lineOf(['services', name, 'ports', i]) ?? p.lineOf(['services', name])
						});
					} else if (!prev) {
						seen.set(parsed.hostPort, name);
					}
				}
			}
			return out;
		}
	},
	{
		id: 'CROSS_STACK_PORT_COLLISION',
		description: 'A host port is already used by another container on the environment',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p, ctx) {
			if (!ctx.usedHostPorts || ctx.usedHostPorts.size === 0) return [];
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				for (let i = 0; i < ports(svc).length; i++) {
					const parsed = parsePortEntry(ports(svc)[i]);
					if (parsed?.hostPort && ctx.usedHostPorts.has(parsed.hostPort)) {
						const owner = ctx.hostPortOwners?.get(parsed.hostPort);
						out.push({
							ruleId: 'CROSS_STACK_PORT_COLLISION',
							service: name,
							message: owner
								? `Host port ${parsed.hostPort} is already in use on this environment by container "${owner}"`
								: `Host port ${parsed.hostPort} is already in use on this environment by another container`,
							hint: owner
								? `Pick a free host port, or stop "${owner}".`
								: 'Pick a free host port, or stop the container using it.',
							line: p.lineOf(['services', name, 'ports', i]) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'DB_PORT_ON_ALL_INTERFACES',
		description: 'A database/cache service publishes a port on all interfaces',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const image = typeof svc.image === 'string' ? svc.image : '';
				if (!DB_CACHE_IMAGE.test(image)) continue;
				for (let i = 0; i < ports(svc).length; i++) {
					const entry = ports(svc)[i];
					const parsed = parsePortEntry(entry);
					if (parsed?.hostPort && (!parsed.hostIp || parsed.hostIp === '0.0.0.0')) {
						const line = p.lineOf(['services', name, 'ports', i]);
						// A fix is only unambiguous for the short string form ("5432:5432" ->
						// "127.0.0.1:5432:5432"). "0.0.0.0:..." is replaced in place; the long
						// object form has no single-token edit, so it gets no fix.
						let fix: RuleFinding['fix'];
						if (line && typeof entry === 'string') {
							const replaceTok =
								parsed.hostIp === '0.0.0.0'
									? entry.replace(/^0\.0\.0\.0:/, '127.0.0.1:')
									: `127.0.0.1:${entry}`;
							// Anchor to this entry's column so a short port that is a substring
							// of an earlier port token on the same (flow) line isn't corrupted.
							const at = p.columnOf(['services', name, 'ports', i]);
							fix = { kind: 'replace-in-line', line, find: entry, replace: replaceTok, at };
						}
						out.push({
							ruleId: 'DB_PORT_ON_ALL_INTERFACES',
							service: name,
							message: `Database/cache service "${name}" publishes port ${parsed.hostPort} on all interfaces`,
							hint: 'Bind to 127.0.0.1 (e.g. "127.0.0.1:5432:5432") or drop the host mapping and reach it over the compose network.',
							line: line ?? p.lineOf(['services', name]),
							fix,
							fixDescription: 'Bind this port to 127.0.0.1 (localhost only)'
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'DEPENDS_ON_UNDEFINED',
		description: 'depends_on references a service not defined in the file',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p) {
			const out: RuleFinding[] = [];
			const svcNames = new Set(Object.keys(services(p)));
			for (const [name, svc] of Object.entries(services(p))) {
				const dep = svc.depends_on;
				const deps = Array.isArray(dep)
					? dep
					: dep && typeof dep === 'object'
						? Object.keys(dep as Record<string, unknown>)
						: [];
				for (const d of deps) {
					if (typeof d === 'string' && !svcNames.has(d)) {
						out.push({
							ruleId: 'DEPENDS_ON_UNDEFINED',
							service: name,
							message: `"${name}" depends_on "${d}", which is not a service in this file`,
							hint: 'Fix the name or define the service.',
							line: p.lineOf(['services', name, 'depends_on']) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'UNDEFINED_NETWORK_REF',
		description: 'A service uses a network that is not defined at the top level',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p) {
			const defined = new Set(Object.keys(asRecord(p.doc?.networks) ?? {}));
			// The implicit `default` network always exists.
			defined.add('default');
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const nets = svc.networks;
				const refs = Array.isArray(nets)
					? nets
					: nets && typeof nets === 'object'
						? Object.keys(nets as Record<string, unknown>)
						: [];
				for (const ref of refs) {
					if (typeof ref === 'string' && !defined.has(ref)) {
						out.push({
							ruleId: 'UNDEFINED_NETWORK_REF',
							service: name,
							message: `"${name}" uses network "${ref}", which is not defined under the top-level networks:`,
							hint: `Add "${ref}" to top-level networks: (mark it external: true if it already exists on the host).`,
							line: p.lineOf(['services', name, 'networks']) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'UNDEFINED_VOLUME_REF',
		description: 'A service mounts a named volume that is not defined at the top level',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p) {
			const defined = new Set(Object.keys(asRecord(p.doc?.volumes) ?? {}));
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
				for (let i = 0; i < vols.length; i++) {
					const v = vols[i];
					// A NAMED volume source is a bare token (no '/' or '.') on the left of ':'
					// in short form, or a { type: volume, source } in long form. Bind mounts
					// (paths) are not named volumes and are exempt.
					let src: string | null = null;
					if (typeof v === 'string') {
						const left = v.split(':')[0];
						if (left && !left.startsWith('/') && !left.startsWith('.') && !left.startsWith('~')) {
							src = left;
						}
					} else {
						const o = asRecord(v);
						if (o?.type === 'volume' && typeof o.source === 'string') src = o.source;
					}
					if (src && !defined.has(src)) {
						out.push({
							ruleId: 'UNDEFINED_VOLUME_REF',
							service: name,
							message: `"${name}" mounts named volume "${src}", which is not defined under the top-level volumes:`,
							hint: `Add "${src}" to top-level volumes: (mark it external: true if it already exists on the host).`,
							line: p.lineOf(['services', name, 'volumes', i]) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'UNUSED_VOLUME',
		description: 'A top-level named volume is defined but never mounted by any service',
		group: 'correctness',
		defaultSeverity: 'info',
		check(p) {
			const definedVolumes = asRecord(p.doc?.volumes) ?? {};
			const definedNames = Object.keys(definedVolumes);
			if (definedNames.length === 0) return [];

			// Collect every named-volume source referenced by any service (same extraction
			// as UNDEFINED_VOLUME_REF: a bare token, or a long-form { type: volume, source }).
			const used = new Set<string>();
			for (const svc of Object.values(services(p))) {
				const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
				for (const v of vols) {
					if (typeof v === 'string') {
						const left = v.split(':')[0];
						if (left && !left.startsWith('/') && !left.startsWith('.') && !left.startsWith('~')) {
							used.add(left);
						}
					} else {
						const o = asRecord(v);
						if (o?.type === 'volume' && typeof o.source === 'string') used.add(o.source);
					}
				}
			}

			const out: RuleFinding[] = [];
			for (const vol of definedNames) {
				if (used.has(vol)) continue;
				// An external volume is often declared just so compose won't try to create it;
				// it may be mounted elsewhere, so don't flag it as unused.
				if (asRecord(definedVolumes[vol])?.external) continue;
				out.push({
					ruleId: 'UNUSED_VOLUME',
					message: `Named volume "${vol}" is defined but no service mounts it`,
					hint: `Mount it from a service under volumes:, or remove it from the top-level volumes: if it is not needed.`,
					line: p.lineOf(['volumes', vol]) ?? p.lineOf(['volumes'])
				});
			}
			return out;
		}
	},
	{
		id: 'CONTAINER_NAME_COLLISION',
		description: 'container_name is already used by a container on the environment',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p, ctx) {
			if (!ctx.existingContainerNames || ctx.existingContainerNames.size === 0) return [];
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const cn = svc.container_name;
				if (typeof cn === 'string' && ctx.existingContainerNames.has(cn)) {
					out.push({
						ruleId: 'CONTAINER_NAME_COLLISION',
						service: name,
						message: `container_name "${cn}" is already used by a container on this environment`,
						hint: 'A fixed container_name prevents clean recreation; remove it or make it unique.',
						line: p.lineOf(['services', name, 'container_name']) ?? p.lineOf(['services', name])
					});
				}
			}
			return out;
		}
	},
	{
		id: 'MISSING_EXTERNAL_RESOURCE',
		description: 'An external network/volume does not exist on the environment',
		group: 'correctness',
		defaultSeverity: 'error',
		check(p, ctx) {
			const out: RuleFinding[] = [];
			const check = (kind: 'networks' | 'volumes', existing: Set<string> | undefined) => {
				if (!existing) return;
				const block = asRecord(p.doc?.[kind]);
				if (!block) return;
				for (const [resName, def] of Object.entries(block)) {
					const d = asRecord(def);
					if (d?.external === true || asRecord(d?.external)) {
						const actual =
							(asRecord(d?.external)?.name as string) ||
							(typeof d?.name === 'string' ? (d.name as string) : resName);
						if (!existing.has(actual)) {
							out.push({
								ruleId: 'MISSING_EXTERNAL_RESOURCE',
								message: `External ${kind === 'networks' ? 'network' : 'volume'} "${actual}" does not exist on this environment`,
								hint: 'Create it first, or drop external: true to let compose create it.',
								line: p.lineOf([kind, resName])
							});
						}
					}
				}
			};
			check('networks', ctx.existingNetworks);
			check('volumes', ctx.existingVolumes);
			return out;
		}
	},
	{
		id: 'LATEST_TAG',
		description: 'An image uses :latest or is untagged',
		group: 'reliability',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const image = typeof svc.image === 'string' ? svc.image : '';
				if (!image) continue;
				const afterSlash = image.substring(image.lastIndexOf('/') + 1);
				const tag = afterSlash.includes(':') ? afterSlash.split(':').pop() : '';
				if (!tag || tag === 'latest') {
					out.push({
						ruleId: 'LATEST_TAG',
						service: name,
						message: `"${name}" uses ${tag ? '`:latest`' : 'an untagged image'} (${image})`,
						hint: 'Pin a version tag for reproducible deploys and to enable newer-version detection.',
						line: p.lineOf(['services', name, 'image']) ?? p.lineOf(['services', name])
					});
				}
			}
			return out;
		}
	},
	{
		id: 'PRIVILEGED_CONTAINER',
		description: 'A service runs privileged (full host access)',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (svc.privileged === true) {
					out.push({
						ruleId: 'PRIVILEGED_CONTAINER',
						service: name,
						message: `"${name}" runs privileged (full host access)`,
						hint: 'Grant specific cap_add instead of privileged where possible.',
						line: p.lineOf(['services', name, 'privileged']) ?? p.lineOf(['services', name])
					});
				}
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_MOUNT',
		description: 'A service mounts the Docker socket',
		group: 'security',
		defaultSeverity: 'warn', // graded: the check upgrades rw to error itself
		check(p) {
			const out: RuleFinding[] = [];
			const proxies = socketProxyNames(p);
			// When the stack already runs a proxy, point a direct-mount finding at it
			// instead of telling the user to adopt something they already have.
			const proxyHint =
				proxies.length > 0
					? `This stack already runs a socket proxy (${proxies.map((n) => `"${n}"`).join(', ')}); route this service through it instead of mounting docker.sock directly.`
					: 'Read-write docker.sock = root on the host. Use a scoped socket proxy.';
			for (const [name, svc] of Object.entries(services(p))) {
				// A classified socket proxy legitimately mounts the socket - the
				// docker-socket-proxy* rules cover it, so skip it here.
				if (isSocketProxyService(name, svc)) continue;
				// Dockhand itself REQUIRES the socket (rw) to manage Docker, so a stack
				// that deploys Dockhand is not a footgun - info note, not error.
				const image = typeof svc.image === 'string' ? svc.image : '';
				const isDockhand = DOCKHAND_IMAGE.test(image);
				const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
				for (let i = 0; i < vols.length; i++) {
					const v = vols[i];
					const src = typeof v === 'string' ? v : asRecord(v)?.source;
					const raw = typeof v === 'string' ? v : '';
					if (typeof src === 'string' && src.includes('docker.sock')) {
						// Read-only if the short-form option field contains `ro` (ro / ro,z /
						// z,ro), or the long form sets read_only. Only 3+ segments have opts.
						const parts = raw.split(':');
						const readonly =
							(parts.length >= 3 && optsAreReadonly(parts[parts.length - 1])) ||
							asRecord(v)?.read_only === true;
						const line = p.lineOf(['services', name, 'volumes', i]) ?? p.lineOf(['services', name]);
						if (isDockhand) {
							out.push({
								ruleId: 'DOCKER_SOCKET_MOUNT',
								severity: 'info',
								service: name,
								message: `"${name}" is Dockhand and mounts the Docker socket - this is a required configuration, not a misconfiguration`,
								hint: 'Dockhand needs the socket to manage Docker. To harden it, put a scoped socket proxy in front.',
								line
							});
						} else {
							out.push({
								ruleId: 'DOCKER_SOCKET_MOUNT',
								severity: readonly ? 'warn' : 'error',
								service: name,
								message: `"${name}" mounts the Docker socket${readonly ? ' (read-only)' : ' read-write (full daemon control)'}`,
								hint: readonly ? 'Read-only still exposes the daemon; consider a socket proxy.' : proxyHint,
								line
							});
						}
					}
				}
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_PROXY',
		description: 'A Docker socket proxy sidecar is present (intentional)',
		group: 'security',
		defaultSeverity: 'info',
		check(p) {
			const out: RuleFinding[] = [];
			for (const name of socketProxyNames(p)) {
				out.push({
					ruleId: 'DOCKER_SOCKET_PROXY',
					service: name,
					message: `"${name}" is a Docker socket proxy - it mounts the socket on purpose to expose a scoped API to other services`,
					hint: 'Keep it on an internal network, do not publish its port, and enable only the API groups dependents need.',
					line: p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_PROXY_WRITABLE',
		description: 'A Docker socket proxy mounts the socket read-write',
		group: 'security',
		defaultSeverity: 'error',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (!isSocketProxyService(name, svc)) continue;
				if (!socketBinds(svc).some((b) => !b.readonly)) continue;
				out.push({
					ruleId: 'DOCKER_SOCKET_PROXY_WRITABLE',
					service: name,
					message: `Socket proxy "${name}" mounts docker.sock read-write - a compromise of the proxy then grants full control of the host`,
					hint: 'Append `:ro` to the socket bind and let the API-group flags do the restricting.',
					line: p.lineOf(['services', name, 'volumes']) ?? p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_PROXY_PUBLISHED',
		description: 'A Docker socket proxy publishes a host port',
		group: 'security',
		defaultSeverity: 'error',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (!isSocketProxyService(name, svc)) continue;
				const hasPublished = ports(svc).some((e) => {
					const parsed = parsePortEntry(e);
					return parsed?.hostPort != null;
				});
				if (!hasPublished) continue;
				out.push({
					ruleId: 'DOCKER_SOCKET_PROXY_PUBLISHED',
					service: name,
					message: `Socket proxy "${name}" publishes a port to the host, making the proxied Docker API reachable beyond the compose network`,
					hint: 'Remove the host port mapping; let dependents reach the proxy only over an internal compose network.',
					line: p.lineOf(['services', name, 'ports']) ?? p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_PROXY_MUTATING',
		description: 'A Docker socket proxy allows mutating (POST/DELETE) API access',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (!isSocketProxyService(name, svc)) continue;
				const mutating = enabledProxyApiFlags(svc).filter((f) => MUTATING_PROXY_API_FLAGS.has(f));
				if (mutating.length === 0) continue;
				out.push({
					ruleId: 'DOCKER_SOCKET_PROXY_MUTATING',
					service: name,
					message: `Socket proxy "${name}" enables ${mutating.join(' and ')} - dependents can perform write/delete operations through it`,
					hint: 'Disable POST and DELETE unless a dependent genuinely needs mutating Docker API calls.',
					line: p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_PROXY_EXPOSURE',
		description: 'A Docker socket proxy sits on a non-internal network',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (!isSocketProxyService(name, svc)) continue;
				if (!proxyAttachesNonInternalNetwork(p, svc)) continue;
				out.push({
					ruleId: 'DOCKER_SOCKET_PROXY_EXPOSURE',
					service: name,
					message: `Socket proxy "${name}" is on a network that is not marked internal: true, which widens who can reach the proxied Docker API`,
					hint: 'Attach the proxy only to internal: true compose networks used by trusted dependents.',
					line: p.lineOf(['services', name, 'networks']) ?? p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'DOCKER_SOCKET_PROXY_CLIENT',
		description: 'A service reaches Docker through a socket proxy instead of mounting the socket',
		group: 'security',
		defaultSeverity: 'info',
		check(p) {
			const proxyEntries = Object.entries(services(p)).filter(([n, s]) => isSocketProxyService(n, s));
			if (proxyEntries.length === 0) return [];
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (mountsDockerSocket(svc)) continue; // it mounts directly - not a proxy client
				const hosts = new Set(dockerEndpointHosts(svc));
				if (hosts.size === 0) continue;
				const svcNets = serviceNetworkKeys(svc);
				const isClient = proxyEntries.some(([pn, ps]) => {
					const reach = proxyReachableNames(pn, ps);
					if (!reach.some((r) => hosts.has(r))) return false;
					const proxyNets = serviceNetworkKeys(ps);
					// Empty membership on either side = implicit default; match only if BOTH default.
					if (svcNets.length === 0 || proxyNets.length === 0) return svcNets.length === 0 && proxyNets.length === 0;
					return svcNets.some((n) => proxyNets.includes(n));
				});
				if (!isClient) continue;
				out.push({
					ruleId: 'DOCKER_SOCKET_PROXY_CLIENT',
					service: name,
					message: `"${name}" reaches Docker through a socket proxy instead of mounting docker.sock directly - the safer pattern`,
					line: p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'OBSOLETE_VERSION_KEY',
		description: 'The top-level version: key is obsolete',
		group: 'schema',
		defaultSeverity: 'info',
		check(p) {
			if (p.doc && 'version' in p.doc) {
				const line = p.lineOf(['version']);
				return [
					{
						ruleId: 'OBSOLETE_VERSION_KEY',
						message: 'The top-level `version:` key is obsolete in the Compose Spec and is ignored',
						hint: 'Safe to remove.',
						line,
						fix: line ? { kind: 'delete-line', line } : undefined,
						fixDescription: 'Remove the obsolete version: line'
					}
				];
			}
			return [];
		}
	},
	{
		id: 'UNKNOWN_SERVICE_KEY',
		description: 'A service key looks like a typo of a real Compose key',
		group: 'schema',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				for (const key of Object.keys(svc)) {
					const suggestion = isLikelyTypo(key, SERVICE_KEYS);
					if (suggestion) {
						const line = p.lineOf(['services', name, key]);
						out.push({
							ruleId: 'UNKNOWN_SERVICE_KEY',
							service: name,
							message: `"${key}" is not a known service key - did you mean "${suggestion}"?`,
							hint: 'Docker silently ignores unknown keys, so this setting never applies.',
							line: line ?? p.lineOf(['services', name]),
							fix: line ? { kind: 'replace-in-line', line, find: key, replace: suggestion } : undefined,
							fixDescription: `Rename "${key}" to "${suggestion}"`
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'UNKNOWN_TOP_LEVEL_KEY',
		description: 'A top-level key looks like a typo',
		group: 'schema',
		defaultSeverity: 'warn',
		check(p) {
			if (!p.doc) return [];
			const out: RuleFinding[] = [];
			for (const key of Object.keys(p.doc)) {
				if (key.startsWith('x-')) continue;
				const suggestion = isLikelyTypo(key, TOP_LEVEL_KEYS);
				if (suggestion) {
					const line = p.lineOf([key]);
					out.push({
						ruleId: 'UNKNOWN_TOP_LEVEL_KEY',
						message: `Top-level "${key}" is not a known key - did you mean "${suggestion}"?`,
						line,
						fix: line ? { kind: 'replace-in-line', line, find: key, replace: suggestion } : undefined,
						fixDescription: `Rename "${key}" to "${suggestion}"`
					});
				}
			}
			return out;
		}
	},
	{
		id: 'SECRET_IN_ENVIRONMENT',
		description: 'A secret-looking value is hard-coded in environment: instead of a secret/${VAR}',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				for (const { key, value, at } of envEntries(svc)) {
					if (value == null || value === '') continue;
					// A ${VAR} interpolation is exactly the safe pattern - never flag it.
					if (value.includes('${')) continue;
					if (!SECRET_NAME.test(key)) continue;
					// *_FILE / *_PATH point at a file to read the secret from - safe.
					if (SECRET_FILE_REF.test(key)) continue;
					// A numeric/boolean value isn't a credential - it's a policy/flag
					// (PASSWORD_POLICY_DAYS=30, TOKEN_ENABLED=true), so don't flag it.
					if (/^(true|false|\d+)$/i.test(value.trim())) continue;
					out.push({
						ruleId: 'SECRET_IN_ENVIRONMENT',
						service: name,
						message: `"${name}" hard-codes a secret value for ${key} in environment:`,
						hint: 'Store it as a Dockhand secret and reference ${' + key + '}, so it never lands in the compose/.env on disk.',
						line: p.lineOf(['services', name, 'environment', at]) ?? p.lineOf(['services', name])
					});
				}
			}
			return out;
		}
	},
	{
		id: 'HOST_NETWORK_MODE',
		description: 'A service uses network_mode: host (no network isolation)',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if (svc.network_mode === 'host') {
					out.push({
						ruleId: 'HOST_NETWORK_MODE',
						service: name,
						message: `"${name}" uses network_mode: host - it shares the host network with no isolation`,
						hint: 'Publish only the ports you need instead, so the container stays on its own network.',
						line: p.lineOf(['services', name, 'network_mode']) ?? p.lineOf(['services', name])
					});
				}
			}
			return out;
		}
	},
	{
		id: 'WRITABLE_ROOT_MOUNT',
		description: 'A sensitive host path is bind-mounted (writable = full host compromise)',
		group: 'security',
		defaultSeverity: 'error', // graded: ro is downgraded to warn by the check
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
				for (let i = 0; i < vols.length; i++) {
					const bind = bindSource(vols[i]);
					if (!bind) continue;
					// docker.sock has its own dedicated rule; don't double-report it here.
					if (bind.source.includes('/var/run/docker.sock')) continue;
					const normalized = bind.source.replace(/\/+$/, '') || '/';
					if (!SENSITIVE_HOST_ROOTS.includes(normalized)) continue;
					out.push({
						ruleId: 'WRITABLE_ROOT_MOUNT',
						severity: bind.readonly ? 'warn' : 'error',
						service: name,
						message: `"${name}" bind-mounts the host path "${bind.source}"${bind.readonly ? ' (read-only)' : ' read-write'}`,
						hint: bind.readonly
							? 'Even read-only, this exposes host system files; mount only the subdirectory you need.'
							: 'A writable mount of a system path lets the container modify the host. Mount a specific subdirectory, read-only.',
						line: p.lineOf(['services', name, 'volumes', i]) ?? p.lineOf(['services', name])
					});
				}
			}
			return out;
		}
	},
	{
		id: 'CAP_ADD_DANGEROUS',
		description: 'A service adds a near-privileged Linux capability',
		group: 'security',
		defaultSeverity: 'warn',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const caps = Array.isArray(svc.cap_add) ? svc.cap_add : [];
				for (let i = 0; i < caps.length; i++) {
					const cap = typeof caps[i] === 'string' ? (caps[i] as string).toUpperCase() : '';
					if (DANGEROUS_CAPS.has(cap)) {
						out.push({
							ruleId: 'CAP_ADD_DANGEROUS',
							service: name,
							message: `"${name}" grants the ${cap} capability (near-privileged)`,
							hint: 'Grant only the narrow capability the workload actually needs.',
							line: p.lineOf(['services', name, 'cap_add', i]) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'MISSING_RESTART_POLICY',
		description: 'A service has no restart policy (will not come back after a host reboot)',
		group: 'reliability',
		defaultSeverity: 'info',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				if ('restart' in svc) continue;
				// Compose Spec: deploy.restart_policy is the swarm-mode equivalent.
				const deploy = asRecord(svc.deploy);
				if (deploy && 'restart_policy' in deploy) continue;

				const svcLine = p.lineOf(['services', name]);
				const firstKey = Object.keys(svc)[0];
				// Only offer an insert-after fix for a BLOCK-style service (children on
				// their own lines). A flow map (`web: {}` or `web: {image: x}`) has no
				// child line to insert under - splicing `restart:` there produces invalid
				// YAML - so those get the finding but no fix.
				const firstKeyLine = firstKey ? p.lineOf(['services', name, firstKey]) : undefined;
				const isBlockService = firstKeyLine != null && svcLine != null && firstKeyLine > svcLine;
				const childIndent = (firstKey ? p.indentOf(['services', name, firstKey]) : undefined) ?? 0;
				const fix =
					isBlockService && childIndent > 0
						? ({
								kind: 'insert-after',
								line: svcLine!,
								text: `${' '.repeat(childIndent)}restart: unless-stopped`
							} as const)
						: undefined;
				out.push({
					ruleId: 'MISSING_RESTART_POLICY',
					service: name,
					message: `"${name}" has no restart: policy - it will not restart after a crash or host reboot`,
					hint: 'Add restart: unless-stopped (or on-failure) unless this is a one-shot task.',
					line: svcLine,
					fix,
					fixDescription: 'Add restart: unless-stopped'
				});
			}
			return out;
		}
	},
	{
		id: 'MISSING_HEALTHCHECK',
		description: 'A service has no healthcheck, so Docker cannot tell whether it is actually working',
		group: 'reliability',
		defaultSeverity: 'info',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				// A compose-declared healthcheck, or one explicitly turned off, is a
				// deliberate choice - don't nag either way. We only see the compose file,
				// not the image's own HEALTHCHECK, so this stays an info-level hint.
				const hc = asRecord(svc.healthcheck);
				if (hc) continue;
				if ('healthcheck' in svc) continue;
				out.push({
					ruleId: 'MISSING_HEALTHCHECK',
					service: name,
					message: `"${name}" has no healthcheck - Docker reports it as running even if the app inside has stopped responding`,
					hint: 'Add a healthcheck so restart policies and depends_on: condition: service_healthy can react to a hung container. The image may already ship one.',
					line: p.lineOf(['services', name])
				});
			}
			return out;
		}
	},
	{
		id: 'SENSITIVE_SERVICE_BROAD_EXPOSURE',
		description: 'An admin/management UI publishes a port on all interfaces',
		group: 'security',
		defaultSeverity: 'error',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const image = typeof svc.image === 'string' ? svc.image : '';
				if (!ADMIN_PANEL_IMAGE.test(image)) continue;
				for (let i = 0; i < ports(svc).length; i++) {
					const parsed = parsePortEntry(ports(svc)[i]);
					if (parsed?.hostPort && (!parsed.hostIp || parsed.hostIp === '0.0.0.0')) {
						out.push({
							ruleId: 'SENSITIVE_SERVICE_BROAD_EXPOSURE',
							service: name,
							message: `Admin UI "${name}" publishes port ${parsed.hostPort} on all interfaces - reachable from the whole network`,
							hint: 'Bind to 127.0.0.1 and reach it through a reverse proxy with auth, or drop the host mapping.',
							line: p.lineOf(['services', name, 'ports', i]) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'ANONYMOUS_VOLUME',
		description: 'A service uses an anonymous volume (data has no stable name and is easy to lose)',
		group: 'reliability',
		defaultSeverity: 'info',
		check(p) {
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
				for (let i = 0; i < vols.length; i++) {
					const v = vols[i];
					// Anonymous = a container path with no source. Short form: a single
					// segment ("/data"), i.e. no ':' mapping. Long form: type volume with
					// no `source`. A bind (./x, /x:/y) or named volume (data:/x) has a
					// source and is NOT anonymous.
					let anon = false;
					if (typeof v === 'string') {
						anon = !v.includes(':');
					} else {
						const o = asRecord(v);
						if (o && (o.type === 'volume' || o.type === undefined) && !o.source) anon = true;
					}
					if (anon) {
						out.push({
							ruleId: 'ANONYMOUS_VOLUME',
							service: name,
							message: `"${name}" uses an anonymous volume - its data has no stable name and is orphaned when the container is recreated`,
							hint: 'Give it a named volume (name:/path) or a bind mount so the data is findable and portable.',
							line: p.lineOf(['services', name, 'volumes', i]) ?? p.lineOf(['services', name])
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'SWARM_ONLY_DEPLOY_KEYS',
		description: 'deploy.* keys that standalone docker compose silently ignores',
		group: 'reliability',
		defaultSeverity: 'warn',
		check(p) {
			// Keys under `deploy:` that ONLY take effect in Swarm mode; `docker
			// compose up` ignores them without warning. Deliberately conservative:
			// deploy.replicas, deploy.mode and deploy.resources ARE partially honored
			// by Compose v2, so they are NOT flagged.
			const SWARM_ONLY = ['placement', 'update_config', 'rollback_config', 'endpoint_mode'];
			const out: RuleFinding[] = [];
			for (const [name, svc] of Object.entries(services(p))) {
				const deploy = asRecord(svc.deploy);
				if (!deploy) continue;
				const present = SWARM_ONLY.filter((k) => k in deploy);
				if (present.length === 0) continue;
				out.push({
					ruleId: 'SWARM_ONLY_DEPLOY_KEYS',
					service: name,
					message: `"${name}" sets deploy.${present.join(', deploy.')} - standalone docker compose ignores these (they only apply in Swarm mode)`,
					hint: 'Use top-level equivalents (e.g. cpus:/mem_limit:, or scale via the CLI) unless you deploy to Swarm.',
					line: p.lineOf(['services', name, 'deploy']) ?? p.lineOf(['services', name])
				});
			}
			return out;
		}
	}
];
