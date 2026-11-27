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

import jsyaml from 'js-yaml';

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
 * `doc` is the object from loadForScratchCheck. Returns relative paths (deduped) to create.
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

/** A reference `docker compose config` would resolve outside the scratch dir: absolute, `..`,
 *  remote (`scheme://`) or interpolated (`${VAR}` - the value is not known here). */
function leavesScratchDir(p: string): boolean {
	return !isInsideRelative(p) || p.includes('$') || p.includes('://');
}

function includePaths(value: unknown): string[] {
	const out: string[] = [];
	const add = (v: unknown) => {
		if (typeof v === 'string') out.push(v);
		else if (Array.isArray(v)) v.forEach(add);
	};
	for (const entry of Array.isArray(value) ? value : [value]) {
		if (typeof entry === 'string') out.push(entry);
		else if (entry && typeof entry === 'object') {
			const e = entry as { path?: unknown; env_file?: unknown; project_directory?: unknown };
			add(e.path);
			add(e.env_file);
			add(e.project_directory);
		}
	}
	return out;
}

/**
 * True when the compose names a file or directory that `docker compose config` would read
 * from outside the scratch validation dir: env_file / label_file, build context, dockerfile
 * and additional_contexts, extends.file, include, and top-level secrets/configs `file:`.
 * Config runs inside Dockhand, so such a reference would read Dockhand's own files and echo
 * them back through the config output or its error text.
 */
export function referencesOutsideScratchDir(doc: unknown): boolean {
	const paths: string[] = [];
	const d = doc as { services?: unknown; include?: unknown; secrets?: unknown; configs?: unknown } | null;
	if (!d || typeof d !== 'object') return false;
	if (d.services && typeof d.services === 'object') {
		for (const svc of Object.values(d.services as Record<string, unknown>)) {
			if (!svc || typeof svc !== 'object') continue;
			const s = svc as { env_file?: unknown; label_file?: unknown; build?: unknown; extends?: unknown };
			paths.push(...envFileEntriesToPaths(s.env_file), ...envFileEntriesToPaths(s.label_file));
			if (typeof s.build === 'string') paths.push(s.build);
			else if (s.build && typeof s.build === 'object') {
				const b = s.build as { context?: unknown; dockerfile?: unknown; additional_contexts?: unknown };
				if (typeof b.context === 'string') paths.push(b.context);
				if (typeof b.dockerfile === 'string') paths.push(b.dockerfile);
				const extra = b.additional_contexts;
				if (extra && typeof extra === 'object') {
					for (const v of Array.isArray(extra) ? extra : Object.values(extra)) {
						if (typeof v === 'string') paths.push(v.includes('=') && Array.isArray(extra) ? v.slice(v.indexOf('=') + 1) : v);
					}
				}
			}
			if (s.extends && typeof s.extends === 'object') {
				const f = (s.extends as { file?: unknown }).file;
				if (typeof f === 'string') paths.push(f);
			}
		}
	}
	if (d.include !== undefined) paths.push(...includePaths(d.include));
	for (const top of [d.secrets, d.configs]) {
		if (!top || typeof top !== 'object') continue;
		for (const def of Object.values(top as Record<string, unknown>)) {
			const f = (def as { file?: unknown } | null)?.file;
			if (typeof f === 'string') paths.push(f);
		}
	}
	return paths.some((p) => leavesScratchDir(p.trim()));
}

// Core scalars plus merge keys only: a tag such as !!binary, which Compose decodes into a
// path string, fails the load here instead of reaching the check as a non-string.
// `types` is exported at runtime but missing from @types/js-yaml.
const { merge } = (jsyaml as unknown as { types: { merge: jsyaml.Type } }).types;
const SCRATCH_CHECK_SCHEMA = jsyaml.CORE_SCHEMA.extend({ implicit: [merge] });

/** The compose as the scratch-dir check reads it, or null when it does not load. */
export function loadForScratchCheck(source: string): unknown {
	try {
		return jsyaml.load(source, { schema: SCRATCH_CHECK_SCHEMA }) ?? null;
	} catch {
		return null;
	}
}
