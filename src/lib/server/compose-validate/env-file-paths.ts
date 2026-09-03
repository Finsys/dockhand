/**
 * Extract the `env_file` paths a compose references, keeping only those safe to MATERIALIZE
 * inside a scratch validation dir. `docker compose config` fails "env file <path> not found"
 * when a referenced env_file is absent from the cwd it runs in - but Compose Validate runs in a
 * throwaway temp dir that has only the compose file, so a perfectly valid `env_file: - .env` is
 * falsely rejected. We pre-create these files (empty) so config resolves.
 *
 * We only return paths that stay INSIDE the temp dir: a relative path with no `..` segment and
 * not absolute. Absolute paths and `../` escapes are left alone (we can't/shouldn't write them;
 * config's error for those is arguably legitimate).
 */

/** Normalize the compose `env_file` value (string | string[] | {path,required?}[]) to paths. */
function envFileEntriesToPaths(value: unknown): string[] {
	const out: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === 'string') {
			if (v.trim()) out.push(v.trim());
		} else if (v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string') {
			const p = (v as { path: string }).path.trim();
			if (p) out.push(p);
		}
	};
	if (typeof value === 'string') push(value);
	else if (Array.isArray(value)) value.forEach(push);
	return out;
}

/** True when `p` is a relative path that stays inside its base dir (no absolute, no `..`). */
function isInsideRelative(p: string): boolean {
	if (!p || p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false; // absolute (posix / windows)
	const segs = p.split(/[\\/]/);
	return !segs.includes('..');
}

/**
 * Every distinct, temp-dir-safe env_file path referenced by any service in the parsed compose.
 * `doc` is the plain object from parseCompose. Returns relative paths (deduped) to create.
 */
export function extractMaterializableEnvFiles(doc: unknown): string[] {
	const services = (doc as { services?: unknown })?.services;
	if (!services || typeof services !== 'object') return [];
	const paths = new Set<string>();
	for (const svc of Object.values(services as Record<string, unknown>)) {
		if (!svc || typeof svc !== 'object') continue;
		const ef = (svc as { env_file?: unknown }).env_file;
		if (ef === undefined) continue;
		for (const p of envFileEntriesToPaths(ef)) {
			if (isInsideRelative(p)) paths.add(p);
		}
	}
	// Cap materialization: a validate request should never create an unbounded number of
	// scratch files. Well past any real compose; the pre-parse already bounds payload size.
	return [...paths].slice(0, 100);
}
