/**
 * backups/restore-script.ts — pure builders for the restore helper-container
 * commands. Two shapes, matching the two restore modes:
 *
 *   new-location: restic restores the requested volumes into a fresh target
 *                 directory. Non-destructive — nothing live is touched.
 *
 *   in-place:     restic restores each volume into a staging dir on the live
 *                 volume's own filesystem, then the phase-marked swap commits it
 *                 (see ./swap). The one destructive mode, made safe by staging.
 *
 * The restic restore for in-place must land each `/volumes/<name>` include under
 * `<live>/.dockhand-restore-new`, which happens by pointing `--target` at the
 * live volume root and letting restic recreate the `/volumes/<name>` path there.
 */
import { shellQuote } from './restic-script';
import { buildInPlaceRestoreScript, SWAP_NEW } from './swap';

/**
 * Build the in-place restore script. For each live volume root, restic restores
 * that include into `<live>/.dockhand-restore-new` (staging), then the swap
 * commits. `liveRoots` are the `/volumes/<name>` bind destinations being
 * restored, already validated as safe paths.
 *
 * We run one restic per volume so each lands in its own staging dir. restic's
 * `--target <live>` plus `--include /volumes/<name>` writes to
 * `<live>/volumes/<name>`, so we first restore to a scratch target then move the
 * restored subtree into `.dockhand-restore-new` — but simpler and equivalent:
 * restore with `--target <live>/.dockhand-restore-new` and strip the leading
 * `/volumes/<name>` via restic's path handling. To keep the shell simple and
 * robust we restore into the staging dir and let the swap move top-level entries.
 */
export function buildInPlaceRestore(
	snapshotId: string,
	liveRoots: string[],
	flags: string[],
): string {
	// One restic restore per volume, each into that volume's staging dir. Using a
	// subshell per restore so a non-zero restic aborts the whole script (set -e in
	// buildInPlaceRestoreScript) before any swap runs.
	const restores = liveRoots.map((live) => {
		const staging = `${live}/${SWAP_NEW}`;
		const include = live; // e.g. /volumes/data
		const args = [
			'restore', '--json', snapshotId,
			'--target', staging,
			'--include', include,
			...flags,
		];
		// restic writes <staging><include> (it recreates the include's full path
		// under the target). Flatten so the swap sees the volume contents directly
		// at the staging root: move <staging><include>/* up to <staging>/, then
		// remove the recreated scaffold (the first path component under staging).
		const restic = `restic ${args.map(shellQuote).join(' ')}`;
		const nested = shellQuote(`${staging}${include}`);
		const stagingQ = shellQuote(staging);
		// include is always `/volumes/<name>`, so the scaffold under staging is its
		// first path component, e.g. `volumes`.
		const firstComponent = include.replace(/^\/+/, '').split('/')[0];
		const scaffold = shellQuote(`${staging}/${firstComponent}`);
		const flatten =
			`( if [ -d ${nested} ]; then cd ${nested}; ` +
			`for e in * .[!.]* ..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; mv -- "$e" ${stagingQ}/; done; ` +
			`fi )`;
		// Narrate FS operations to stderr (streamed live to the restore log).
		const say = (m: string) => `echo ${shellQuote(`[dockhand] ${m}`)} >&2`;
		// SAFE: `scaffold` = <live>/.dockhand-restore-new/volumes — the `volumes`
		// rung INSIDE our own staging dir, NEVER <live>/volumes. So this rm can't
		// touch a user's own `volumes/` directory at the live root (that's the bug
		// the CLONE path had before it moved to a staging dir — see buildCloneRestore).
		return [
			`${say(`Restoring ${include} into staging dir ${SWAP_NEW}`)}`,
			restic,
			flatten,
			`rm -rf ${scaffold}`,
		].join('; ');
	}).join('; ');

	return buildInPlaceRestoreScript(liveRoots, restores);
}

/**
 * Build the CLONE restore script: restic restores each volume's `/volumes/<name>`
 * include DIRECTLY into that volume's mount root (a fresh named volume or host
 * path on the target env, bound `:rw` into the helper). Unlike in-place there is
 * NO staging dir and NO swap — the destination is fresh, so we write straight
 * into it. Unlike new-location (`--target <path>` loose files) the data lands at
 * the mount root so a container mounting that volume sees it as its own contents.
 *
 * `mountRoots` are the `/volumes/<name>` bind destinations inside the helper,
 * already validated as safe. restic's `--target <root>` + `--include <root>`
 * writes `<root>/volumes/<name>`, so we flatten that subtree up to `<root>/` and
 * remove the recreated scaffold — same mechanic as in-place's flatten, minus the
 * swap wrapper. Runs under `set -e` so any restic/flatten failure aborts.
 */
export function buildCloneRestore(
	snapshotId: string,
	mountRoots: string[],
	flags: string[],
): string {
	// Per-restore staging name: two clones that happen to target the SAME host path
	// (e.g. two different snapshots restored into /srv/shared, from different repos so
	// the per-repo serializer doesn't order them) must NOT share one staging dir, or
	// one's `rm -rf` would wipe the other's in-flight files. Keying the staging dir on
	// the snapshot id makes each restore's staging unique; two clones of the SAME
	// snapshot are already serialized per-repo, so they never overlap.
	const staging_name = cloneStagingName(snapshotId);
	const restores = mountRoots.map((root) => {
		const include = root; // e.g. /volumes/data — mounted at the helper root
		// DATA SAFETY: restic recreates the include path under `--target`, so we must
		// flatten `.../volumes/<name>/*` up to the mount root. We do that via an
		// ISOLATED staging dir INSIDE the mount (mirroring the in-place path), NOT by
		// writing straight into the mount and `rm -rf`-ing a `volumes` scaffold there.
		// The old approach did `rm -rf <mount>/volumes`, which would delete a user's
		// OWN `volumes/` sub-directory if the bind destination happened to contain one.
		// Restic runs WITHOUT --delete, so files already at the mount are preserved;
		// the restored files are moved in ON TOP (overwriting only name collisions),
		// then the staging dir — created by us, never the user — is removed.
		const staging = `${root}/${staging_name}`;
		const args = [
			'restore', '--json', snapshotId,
			'--target', staging,
			'--include', include,
			...flags,
		];
		const restic = `restic ${args.map(shellQuote).join(' ')}`;
		const nested = shellQuote(`${staging}${include}`);   // <staging>/volumes/<name>
		const nestedDot = shellQuote(`${staging}${include}/.`);
		const rootQ = shellQuote(root);
		const stagingQ = shellQuote(staging);
		// MERGE the restored tree onto the mount root: `cp -a <staging>/./.` copies
		// every entry (incl. dotfiles) into the destination, RECURSIVELY MERGING into
		// existing directories. Plain `mv` can't do this — it refuses ("Directory not
		// empty") when a restored dir (e.g. `blueprints`) already exists at the mount,
		// which is exactly the cross-env restore case where data is already present.
		// cp overwrites file collisions and keeps the user's other files intact.
		const move =
			`( if [ -d ${nested} ]; then cp -a ${nestedDot} ${rootQ}/; fi )`;
		// Narrate each FS operation to stderr (streamed live to the restore log with a
		// [dockhand] pill) so the user sees exactly what happens to their files.
		const say = (m: string) => `echo ${shellQuote(`[dockhand] ${m}`)} >&2`;
		// Remove ONLY our staging dir (recursive is safe — it's ours, and the payload
		// was copied out). Never touches any user directory at the mount.
		return [
			`${say(`Cloning into ${root} (staging dir ${staging_name})`)}`,
			`rm -rf ${stagingQ}`,
			restic,
			`${say(`Moving restored files into ${root}`)}`,
			move,
			`${say(`Cleaning up staging dir at ${root}`)}`,
			`rm -rf ${stagingQ}`,
		].join('; ');
	}).join('; ');
	return `set -e; ${restores}`;
}

/** The isolated staging sub-directory a clone restore extracts into before moving
 * files up to the mount root. Named/owned by Dockhand (so its cleanup can never
 * touch the user's own files at the destination) and keyed on the snapshot id (so
 * two concurrent clones into the same host path don't share — and wipe — one dir). */
export function cloneStagingName(snapshotId: string): string {
	const safe = snapshotId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'x';
	return `.dockhand-clone-${safe}`;
}

/**
 * Build the new-location restore command: restic restores the requested volumes
 * (or the whole snapshot) into a fresh target directory. Non-destructive.
 */
export function buildNewLocationRestore(
	snapshotId: string,
	targetPath: string,
	includes: string[],
	flags: string[],
): string[] {
	const args = ['restore', '--json', snapshotId, '--target', targetPath];
	for (const inc of includes) args.push('--include', inc);
	args.push(...flags);
	return args;
}
