/**
 * Single source of truth for WHERE a restore lands on disk. Both the restore preview and the
 * actual restore paths derive their target locations from this pure function, so the paths shown
 * to the user are EXACTLY the paths restic writes to - they cannot diverge because they are the
 * same computation.
 *
 * Pure and import-light (only restore-core, which is itself pure) so it is unit-testable directly:
 * no docker, db, or fs. The caller loads the snapshot metadata and resolves stackDir once and
 * passes them in.
 *
 * This module computes targets in PARALLEL to the write path (runClonePopulate / runInPlaceSwap /
 * writeLocalStackFiles) - it does not replace their bind construction. Identity is enforced by
 * tests asserting resolveRestoreTargets(...).target === the source those paths actually bind.
 */
import { resolveBindFromMetadata, volumeBind, volumeInclude, type SnapshotMetadata } from './restore-core';
import { isReservedVolumeKey } from './stackdir-plan';

/** A single volume's resolved destination. For a bind, `target` is the absolute host path restic
 * writes to; for a named volume, `target` is the volume name docker resolves on the target host.
 * `include` (`/volumes/<key>`) and `bind` (`<target>:/volumes/<key>:rw`) are the exact strings the
 * restore write path feeds to restic - the resolver is the ONE place they are built, so the dialog
 * preview and the actual restore can't diverge (both consume this). */
export interface ResolvedVolumeTarget {
	key: string;
	type: 'bind' | 'volume';
	target: string;
	include: string;
	bind: string;
	origin: 'clone' | 'in-place-metadata' | 'loose-files';
}

/** The rw bind + include for a resolved target - uses the shared builder (restore-core) so the
 * mount-point contract lives in one place. */
function bindMaterial(target: string, key: string): { include: string; bind: string } {
	return { include: volumeInclude(key), bind: volumeBind(target, key, 'rw') };
}

/** Where the stack's captured compose/.env/config files land (the canonical managed stack dir). */
export interface ResolvedStackFiles {
	targetDir: string;
	willWrite: boolean;
	/** true = the managed dir is replaced (stale files cleared); false = merge (mergeStackFiles). */
	overwrite: boolean;
}

export interface ResolvedRestoreTargets {
	volumes: ResolvedVolumeTarget[];
	stackFiles: ResolvedStackFiles | null;
	/** Volumes whose target could not be resolved (fail-closed cases surfaced as data, not thrown,
	 * so the preview can render a warning row instead of the whole call blowing up). */
	unresolved: Array<{ key: string; reason: string }>;
}

/** The subset of a RestoreJob this resolver needs. Kept structural so the module stays import-light
 * (no dependency on restore-service's full RestoreJob type). */
export interface RestoreTargetInput {
	mode: 'in-place' | 'new-location';
	targetType?: 'container' | 'stack';
	targetName?: string | null;
	targetPath?: string | null;
	volumeDestinations?: Array<{ volume: string; kind: 'volume' | 'path'; target: string }>;
	skipStackFiles?: boolean;
	mergeStackFiles?: boolean;
}

/**
 * Resolve the final on-disk targets for a restore. `volumes` is the requested volume-key list
 * (reserved keys like the stack-dir synthetic volume are ignored - they are handled via stackFiles).
 * `metadata` and `stackDir` are pre-loaded by the caller.
 */
export function resolveRestoreTargets(input: {
	job: RestoreTargetInput;
	volumes: string[];
	metadata: SnapshotMetadata | null;
	stackDir: string | null;
}): ResolvedRestoreTargets {
	const { job, metadata, stackDir } = input;
	const volumes: ResolvedVolumeTarget[] = [];
	const unresolved: Array<{ key: string; reason: string }> = [];

	// The stack-dir synthetic volume is not a user volume; it rides stackFiles, not this list.
	const requested = input.volumes.filter((k) => !isReservedVolumeKey(k));

	if (job.mode === 'new-location') {
		// CLONE: destinations are used VERBATIM (mirrors runClonePopulate). A path -> absolute host
		// path bound as-is; a volume -> a named volume created on the target env. Volumes with no
		// destination fall back to loose-files extraction under targetPath.
		const destByVolume = new Map((job.volumeDestinations ?? []).map((d) => [d.volume, d]));
		for (const key of requested) {
			const d = destByVolume.get(key);
			if (d) {
				// The write path binds `${d.target}:${include}:rw` verbatim (restore-service.ts).
				const { include, bind } = bindMaterial(d.target, key);
				volumes.push({ key, type: d.kind === 'path' ? 'bind' : 'volume', target: d.target, include, bind, origin: 'clone' });
			} else if (job.targetPath) {
				// Loose-files fallback: the write path extracts to targetPath with the bind
				// `${targetPath}:${targetPath}` (NOT the /volumes/<key> template) - mirror that shape.
				volumes.push({ key, type: 'bind', target: job.targetPath, include: `/volumes/${key}`, bind: `${job.targetPath}:${job.targetPath}`, origin: 'loose-files' });
			} else {
				unresolved.push({ key, reason: 'no destination mapping and no target path to extract to' });
			}
		}
	} else {
		// IN-PLACE: re-resolve each volume from the snapshot metadata - the SAME call the swap uses,
		// so the shown path equals the written path. resolveBindFromMetadata returns the exact
		// bind/include the swap consumes; take them 1:1. A bind whose absolute source is
		// unrecoverable throws; catch it into unresolved (the swap keeps throwing).
		for (const key of requested) {
			try {
				const vb = resolveBindFromMetadata(metadata, key);
				volumes.push({ key, type: vb.type, target: vb.source, include: vb.include, bind: vb.bind, origin: 'in-place-metadata' });
			} catch (e) {
				unresolved.push({ key, reason: e instanceof Error ? e.message : String(e) });
			}
		}
	}

	// Stack files land in the managed stack dir. Written only for a stack restore that isn't
	// opting out (skipStackFiles) and has a target name + resolved dir. Mirrors the guard in
	// runNewLocationStack / runCloneStack.
	let stackFiles: ResolvedStackFiles | null = null;
	if (job.targetType === 'stack' && stackDir) {
		const willWrite = !!job.targetName && !job.skipStackFiles;
		stackFiles = { targetDir: stackDir, willWrite, overwrite: job.mergeStackFiles !== true };
	}

	return { volumes, stackFiles, unresolved };
}
