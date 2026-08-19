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

// Env-var NAMES that look like a secret (matched case-insensitively as a whole word part).
// Secret-looking env NAMES. Anchored on word/underscore boundaries so a secret word
// must be a whole segment (matches DB_PASSWORD, API_KEY; not TOKENIZED, PASSWORD_POLICY-
// style substrings). Plural credentials allowed.
const SECRET_NAME =
	/(^|[_-])(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credentials?)([_-]|$)/i;
// `*_FILE` / `*_PATH` name a file to READ the secret from - that's the SAFE pattern
// (Docker/compose secrets), so don't flag those even if the name contains "password".
const SECRET_FILE_REF = /(_file|_path)$/i;

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
			for (const [name, svc] of Object.entries(services(p))) {
				const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
				for (let i = 0; i < vols.length; i++) {
					const v = vols[i];
					const src = typeof v === 'string' ? v : asRecord(v)?.source;
					const raw = typeof v === 'string' ? v : '';
					if (typeof src === 'string' && src.includes('/var/run/docker.sock')) {
						// Read-only if the short-form option field contains `ro` (ro / ro,z /
						// z,ro), or the long form sets read_only. Only 3+ segments have opts.
						const parts = raw.split(':');
						const readonly =
							(parts.length >= 3 && optsAreReadonly(parts[parts.length - 1])) ||
							asRecord(v)?.read_only === true;
						out.push({
							ruleId: 'DOCKER_SOCKET_MOUNT',
							severity: readonly ? 'warn' : 'error',
							service: name,
							message: `"${name}" mounts the Docker socket${readonly ? ' (read-only)' : ' read-write (full daemon control)'}`,
							hint: readonly
								? 'Read-only still exposes the daemon; consider a socket proxy.'
								: 'Read-write docker.sock = root on the host. Use a scoped socket proxy.',
							line: p.lineOf(['services', name, 'volumes', i]) ?? p.lineOf(['services', name])
						});
					}
				}
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
	}
];
