/**
 * The ONE typed contract for a snapshot's metadata.json. Capture PRODUCES a
 * SnapshotLayout (buildSnapshotLayout + serializeLayout); restore CONSUMES it
 * (parseSnapshotLayout). Both ends share this type, so a drift between what capture
 * writes and what restore reads is a COMPILE error, not a silent `undefined`.
 *
 * Pure and import-light (no db/docker/fs) so it is unit-testable directly.
 */

/** Schema version of the metadata.json payload. Bump ONLY on a breaking shape change.
 * Backups are beta -> v1 is the first version. A snapshot written before this contract
 * has NO version field; the parser accepts a missing version as v1 (see parse) so beta
 * testers' existing snapshots keep restoring. */
export const SNAPSHOT_LAYOUT_VERSION = 1 as const;

export type VolumeKind = 'volume' | 'bind';

/** One captured data channel. `key` is the /volumes/<key> segment restic lists and the
 * restore UI indexes on. `source` is the bind's ABSOLUTE host path, or (for a named
 * volume) the volume name - what an in-place restore rebinds to. */
export interface SnapshotVolume {
	key: string;
	name: string;
	source: string;
	type: VolumeKind;
}

/** A stack secret carried IN the snapshot: `value` is at-rest ciphertext (enc:v1:...),
 * NEVER plaintext. materialise writes these to the DB on restore; the UI shows only the
 * `key`s. */
export interface SnapshotSecret {
	key: string;
	value: string;
}

/** The stack half of a snapshot. Present iff type==='stack' AND a compose file was
 * resolved at capture. The stack dir ALWAYS lives at /volumes/__dockhand_stackdir__ (the
 * helper's host bind mount) -> no path is stored; restore uses stackDirSource(). */
/** One captured stack file, for browse/debug: relative path + byte size. */
export interface SnapshotStackFile {
	path: string;
	bytes: number;
}

export interface SnapshotStack {
	composeFileName: string;
	fileList: SnapshotStackFile[];
	excludedBindDirs: string[];
	secrets: SnapshotSecret[];
}

/** The typed metadata.json payload. This IS the snapshot contract. `hasStackFiles` is
 * NOT a field here on purpose: it is DERIVED as `layout.stack !== undefined`, so a flag
 * can never disagree with the actual captured stack. */
export interface SnapshotLayout {
	version: typeof SNAPSHOT_LAYOUT_VERSION;
	type: 'container' | 'stack';
	targetName: string;
	environmentId: number | null;
	backupTime: string;
	volumes: SnapshotVolume[];
	/** Present only for a container backup (recreate-as-is). Opaque inspect JSON. */
	container?: unknown;
	/** Present only for a stack backup with a resolved compose. */
	stack?: SnapshotStack;
}

/** Capture-side builder. The single place a SnapshotLayout is constructed - no bare
 * `metadata.x = ...` bag anywhere else. */
export function buildSnapshotLayout(input: {
	type: 'container' | 'stack';
	targetName: string;
	environmentId: number | null;
	backupTime: string;
	volumes: SnapshotVolume[];
	container?: unknown;
	stack?: SnapshotStack;
}): SnapshotLayout {
	return { version: SNAPSHOT_LAYOUT_VERSION, ...input };
}

/** Serialize for writing to /metadata/metadata.json (pretty, matching the prior format). */
export function serializeLayout(layout: SnapshotLayout): string {
	return JSON.stringify(layout, null, 2);
}

function isVolumeKind(v: unknown): v is VolumeKind {
	return v === 'volume' || v === 'bind';
}

/** Parse+validate a raw metadata.json string into a typed SnapshotLayout, or null on ANY
 * problem (bad JSON, wrong version, missing/wrong-typed required field). NEVER throws:
 * restore turns null into an explicit, logged "metadata unreadable" branch instead of a
 * cascade of undefineds. A missing `version` is treated as v1 (pre-contract beta
 * snapshot). Unknown FUTURE versions return null (we can't safely read them). */
export function parseSnapshotLayout(raw: string): SnapshotLayout | null {
	let o: any;
	try { o = JSON.parse(raw); } catch { return null; }
	if (!o || typeof o !== 'object') return null;

	// Accept missing version (pre-contract beta) as v1; reject any other value.
	const version = o.version === undefined ? SNAPSHOT_LAYOUT_VERSION : o.version;
	if (version !== SNAPSHOT_LAYOUT_VERSION) return null;

	if (o.type !== 'container' && o.type !== 'stack') return null;
	if (typeof o.targetName !== 'string') return null;
	const environmentId = typeof o.environmentId === 'number' ? o.environmentId : null;
	const backupTime = typeof o.backupTime === 'string' ? o.backupTime : '';

	// volumes[]: coerce defensively, drop any malformed entry rather than failing the whole
	// parse (a snapshot with one odd volume entry should still restore the rest).
	const volumes: SnapshotVolume[] = Array.isArray(o.volumes)
		? o.volumes
			.filter((v: any) => v && typeof v.key === 'string' && isVolumeKind(v.type))
			.map((v: any) => ({
				key: v.key as string,
				name: typeof v.name === 'string' ? v.name : v.key,
				source: typeof v.source === 'string' ? v.source : '',
				type: v.type as VolumeKind,
			}))
		: [];

	let stack: SnapshotStack | undefined;
	if (o.stack && typeof o.stack === 'object' && typeof o.stack.composeFileName === 'string') {
		stack = {
			composeFileName: o.stack.composeFileName,
			fileList: Array.isArray(o.stack.fileList)
				? o.stack.fileList
					.filter((f: any) => f && typeof f.path === 'string' && typeof f.bytes === 'number')
					.map((f: any) => ({ path: f.path as string, bytes: f.bytes as number }))
				: [],
			excludedBindDirs: Array.isArray(o.stack.excludedBindDirs) ? o.stack.excludedBindDirs.filter((x: any) => typeof x === 'string') : [],
			secrets: Array.isArray(o.stack.secrets)
				? o.stack.secrets
					.filter((s: any) => s && typeof s.key === 'string' && typeof s.value === 'string')
					.map((s: any) => ({ key: s.key as string, value: s.value as string }))
				: [],
		};
	}

	return {
		version: SNAPSHOT_LAYOUT_VERSION,
		type: o.type,
		targetName: o.targetName,
		environmentId,
		backupTime,
		volumes,
		container: o.container,
		stack,
	};
}

/** Shape returned to the client: same as SnapshotLayout but with all secret-bearing
 * fields removed. `container` inspect keeps its shape MINUS Config.Env/Labels; stack
 * secrets collapse to names. */
export type RedactedSnapshotLayout = Omit<SnapshotLayout, 'container' | 'stack'> & {
	container?: unknown;
	hasStackFiles: boolean;
	stack?: (Omit<SnapshotStack, 'secrets'> & { secretKeys: string[] });
};

/** SINGLE redaction point for any snapshot metadata that reaches the client (the
 * metadata route AND the dump route serving metadata.json). Strips:
 *  - stack.secrets VALUES (at-rest ciphertext) -> secretKeys names only
 *  - container inspect Config.Env (plaintext env vars: DB passwords, API keys, tokens)
 *    and Config.Labels (compose can stash secrets in labels)
 * The full inspect is kept server-side for recreate; it must NEVER leave the process
 * un-redacted. `backups:view` is a weaker grant than `containers:view`, so leaking the
 * inspect here would defeat RBAC secret-hiding. */
export function redactSnapshotLayout(metadata: SnapshotLayout): RedactedSnapshotLayout {
	const { stack, container, ...rest } = metadata;
	return {
		...rest,
		hasStackFiles: stack !== undefined,
		container: redactContainerInspect(container),
		stack: stack
			? { ...stack, secrets: undefined as never, secretKeys: stack.secrets.map((s) => s.key) } as any
			: undefined,
	} as RedactedSnapshotLayout;
}

/** Remove secret-bearing keys from an opaque Docker inspect object (Config.Env, Config.Labels).
 * Returns the value untouched if it isn't the expected shape (defensive - never throw). */
function redactContainerInspect(container: unknown): unknown {
	if (!container || typeof container !== 'object') return container;
	const c = container as any;
	if (!c.Config || typeof c.Config !== 'object') return container;
	const { Env, Labels, ...configRest } = c.Config;
	return { ...c, Config: { ...configRest, Env: undefined, Labels: undefined } };
}
