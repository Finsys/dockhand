/**
 * Compose Spec property vocabularies, per level, for the typo detector.
 *
 * Docker silently IGNORES unknown keys, so a typo'd `restart:` (`resart:`) never
 * applies and there is no error - the classic invisible footgun. We flag a key that
 * is NOT in the vocabulary but is edit-distance-close to one that is. Vocab seeded
 * from the Compose Spec and the dcvalidator prior art (~/projects/dcvalidator
 * typoMistake.py), trimmed to current spec keys.
 */

export const SERVICE_KEYS = new Set([
	'image', 'build', 'command', 'entrypoint', 'environment', 'env_file', 'ports',
	'expose', 'volumes', 'volumes_from', 'networks', 'network_mode', 'depends_on',
	'restart', 'healthcheck', 'labels', 'container_name', 'hostname', 'domainname',
	'user', 'working_dir', 'dns', 'dns_search', 'extra_hosts', 'external_links',
	'links', 'cap_add', 'cap_drop', 'devices', 'security_opt', 'sysctls', 'ulimits',
	'privileged', 'read_only', 'tty', 'stdin_open', 'stop_signal', 'stop_grace_period',
	'logging', 'deploy', 'configs', 'secrets', 'profiles', 'pull_policy', 'platform',
	'init', 'ipc', 'pid', 'mac_address', 'shm_size', 'tmpfs', 'mem_limit', 'cpus',
	'cpu_shares', 'mem_reservation', 'runtime', 'group_add', 'isolation', 'scale',
	'cgroup_parent', 'credential_spec', 'device_cgroup_rules', 'extends', 'annotations'
]);

export const TOP_LEVEL_KEYS = new Set([
	'version', 'services', 'networks', 'volumes', 'configs', 'secrets', 'name', 'include'
]);

export const BUILD_KEYS = new Set([
	'context', 'dockerfile', 'args', 'cache_from', 'cache_to', 'labels', 'shm_size',
	'target', 'network', 'extra_hosts', 'isolation', 'no_cache', 'pull', 'platforms',
	'secrets', 'ssh', 'tags', 'additional_contexts', 'dockerfile_inline'
]);

/** Case-insensitive Levenshtein <= 2 and the key is a non-trivial length. */
export function isLikelyTypo(key: string, vocab: Set<string>): string | null {
	const k = key.toLowerCase();
	if (vocab.has(k)) return null;
	if (k.length < 3) return null;
	let best: string | null = null;
	let bestDist = 3; // only care about distance <= 2
	for (const known of vocab) {
		const d = levenshtein(k, known);
		if (d < bestDist) {
			bestDist = d;
			best = known;
		}
	}
	return bestDist <= 2 ? best : null;
}

/** Small iterative Levenshtein (two-row). Adequate for short compose keys. */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array(n + 1);
	let curr = new Array(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}
