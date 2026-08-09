/**
 * backups/swap.ts — the shell scripts that make an in-place volume restore safe.
 * PURE string builders (no I/O), so the commit protocol is unit-testable against a
 * real temp filesystem.
 *
 * An in-place restore replaces a live volume's contents with a snapshot's. Deleting
 * live data then copying the restore in is a data-loss trap: a mid-copy failure
 * leaves an empty volume reported as success. Instead: restore ON THE SIDE first,
 * then swap by moving directory entries, never deleting the original until the
 * replacement is committed. Protocol per volume:
 *
 *   phase 0  recover any interrupted PRIOR swap (see recovery script) — never
 *            blindly delete `.dockhand-restore-old`, it may be the only copy.
 *   phase 1  restic restores into `<live>/.dockhand-restore-new` - a staging dir ON
 *            THE LIVE VOLUME'S OWN FILESYSTEM. Failure-prone; if it fails, live data
 *            is untouched.
 *   marker 2 move the live entries aside into `.dockhand-restore-old`
 *            (same-filesystem renames - fast and reversible).
 *   marker 3 move the restored entries from `.dockhand-restore-new` up into the
 *            live root (same-filesystem renames).
 *   done     drop the marker and delete `.dockhand-restore-old` — the ONLY point
 *            at which the original is deleted, and only after the new data is in place.
 *
 * A same-filesystem `mv` of a directory entry is atomic; the loops move TOP-LEVEL
 * entries (not a recursive per-file copy), so the window is a handful of renames.
 *
 * Crash case fail-fast cannot cover: an external SIGKILL (timeout, daemon restart,
 * reboot, OOM) can land BETWEEN the marker-2 and marker-3 loops, leaving the live
 * root partly emptied with originals in `.dockhand-restore-old`. The phase marker
 * makes that state detectable; the recovery script rolls it back. Recovery runs at
 * the start of every restore AND on startup for a dead-process restore, so a
 * half-swapped state is always reconciled before anything else touches the volume.
 */

/** Basenames of the swap artifacts created inside a live volume root. Exported
 * as the single source of truth: the swap/recovery loops skip them, and the
 * backup path excludes them so a backup taken mid-swap never captures the
 * transient `.dockhand-restore-old` (the sole copy of the pre-restore data). */
export const SWAP_NEW = '.dockhand-restore-new';
export const SWAP_OLD = '.dockhand-restore-old';
export const SWAP_PHASE = '.dockhand-restore-phase';
export const SWAP_ARTIFACTS = [SWAP_NEW, SWAP_OLD, SWAP_PHASE] as const;

/** Single-quote a value for safe interpolation into an `sh -c` string. */
function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Move every top-level entry of `src` into `dst`, skipping our own swap
 * artifacts, in a subshell so `cd` stays local. The glob covers dotfiles too.
 * `[ -e ] || [ -L ]` guards an empty dir (the glob stays literal otherwise).
 */
function moveEntries(src: string, dst: string): string {
	return (
		`( cd ${src}; for e in * .[!.]* ..?*; do ` +
		`[ -e "$e" ] || [ -L "$e" ] || continue; ` +
		`case "$e" in ${SWAP_NEW}|${SWAP_OLD}|${SWAP_PHASE}) continue;; esac; ` +
		`mv -- "$e" ${dst}/; done )`
	);
}

/**
 * Remove every top-level entry of `dir` except our swap artifacts. Used by the
 * phase-3 recovery, where everything left in the live root is restored-new
 * content that must be cleared before the originals are moved back.
 */
function removeEntries(dir: string): string {
	return (
		`( cd ${dir}; for e in * .[!.]* ..?*; do ` +
		`[ -e "$e" ] || [ -L "$e" ] || continue; ` +
		`case "$e" in ${SWAP_NEW}|${SWAP_OLD}|${SWAP_PHASE}) continue;; esac; ` +
		`rm -rf -- "$e"; done )`
	);
}

/**
 * Roll back an interrupted PRIOR swap of one live volume root, restoring the
 * pre-restore content. The phase marker says where a kill landed:
 *   marker "2": live was being emptied into OLD. Each original entry is in the
 *               live root XOR in OLD (never both), so moving OLD's entries back
 *               reassembles the original with no collisions.
 *   marker "3": live was fully emptied, then being refilled from NEW. Every
 *               non-artifact entry now in live is restored-NEW content → remove
 *               it, then move ALL originals back from OLD.
 * No marker → nothing was interrupted → no-op. Runs under the caller's `set -e`,
 * so a rollback failure aborts loudly rather than proceeding to destroy the
 * only surviving copy.
 */
function recoverOne(live: string): string {
	const liveQ = sq(live);
	const newQ = sq(`${live}/${SWAP_NEW}`);
	const oldQ = sq(`${live}/${SWAP_OLD}`);
	const phaseQ = sq(`${live}/${SWAP_PHASE}`);
	// Narrate ONLY when a marker is present (an interrupted prior swap is actually
	// being rolled back), so a normal restore stays quiet but a re-run after a crash
	// tells the user their volume is being recovered. Streamed to the restore log.
	const say = (m: string) => `echo ${sq(`[dockhand] ${m}`)} >&2`;
	return [
		`if [ -f ${phaseQ} ]; then`,
		`  ${say(`Recovering ${live}: rolling back an interrupted previous restore`)};`,
		`  if [ "$(cat ${phaseQ})" = "3" ]; then ${removeEntries(liveQ)}; fi;`,
		`  if [ -d ${oldQ} ]; then ${moveEntries(oldQ, liveQ)}; fi;`,
		`  rm -rf ${newQ} ${oldQ}; rm -f ${phaseQ};`,
		`fi`,
	].join(' ');
}

/**
 * Build the swap sequence for ONE live volume, given that restic has already
 * restored this include's content into `<live>/.dockhand-restore-new`.
 * Assumes any interrupted prior swap was ALREADY recovered before restic staged
 * into NEW (see buildInPlaceRestoreScript ordering), and the caller runs under
 * `set -e`.
 */
function swapOne(live: string): string {
	const liveQ = sq(live);
	const newQ = sq(`${live}/${SWAP_NEW}`);
	const oldQ = sq(`${live}/${SWAP_OLD}`);
	const phaseQ = sq(`${live}/${SWAP_PHASE}`);
	// Narrate the destructive swap phases to stderr (streamed live to the restore log).
	const say = (m: string) => `echo ${sq(`[dockhand] ${m}`)} >&2`;
	return [
		// The restored content must exist before we touch anything live.
		`if [ -d ${newQ} ]; then`,
		// No prior swap can remain here (recovery already ran, before restic
		// staged NEW). Clear only a stale OLD/marker, never NEW.
		`  rm -rf ${oldQ}; rm -f ${phaseQ};`,
		`  mkdir -p ${oldQ};`,
		// marker 2: move live entries aside (reversible).
		`  ${say(`Swapping ${live}: moving live data aside`)};`,
		`  printf 2 > ${phaseQ};`,
		`  ${moveEntries(liveQ, oldQ)};`,
		// marker 3: move restored entries up into the live root.
		`  ${say(`Swapping ${live}: committing restored data`)};`,
		`  printf 3 > ${phaseQ};`,
		`  ${moveEntries(newQ, liveQ)};`,
		// committed: drop the marker, the now-empty NEW, and the old content.
		`  ${say(`Swapping ${live}: removing the previous data`)};`,
		`  rm -f ${phaseQ}; rmdir ${newQ}; rm -rf ${oldQ};`,
		`fi`,
	].join(' ');
}

/**
 * Build the full in-place restore script for the helper container. The ordering
 * is critical and fixes a subtle interaction: recovery of any interrupted PRIOR
 * swap must run BEFORE restic stages the new content, because both use the
 * `.dockhand-restore-new` staging dir — recovering after staging would delete
 * the fresh restore's content.
 *   1. recover any interrupted prior swap for every volume (restores originals;
 *      no-op where no marker is present).
 *   2. restic restores each include into its `<live>/.dockhand-restore-new`
 *      (`--target` = the live volume root, so `/volumes/<v>` lands under it).
 *   3. per volume, swap the restored content into place.
 * Runs under `set -e`: a recovery, restic, or swap failure aborts before the
 * commit, leaving live data intact.
 *
 * @param liveRoots  the live volume roots being restored, e.g. ['/volumes/data'].
 *                   MUST already be validated as safe `/volumes/<name>` paths.
 * @param resticCmd  the fully-built `restic restore ...` command that writes each
 *                   include into `<live>/.dockhand-restore-new`.
 */
export function buildInPlaceRestoreScript(liveRoots: string[], resticCmd: string): string {
	const recover = liveRoots.map(recoverOne).join('; ');
	const swaps = liveRoots.map(swapOne).join('; ');
	return `set -e; ${recover}; ${resticCmd}; ${swaps}`;
}

/**
 * Build a standalone recovery script that rolls back an interrupted swap for
 * each given live volume root (a no-op where no phase marker is present). Run at
 * the start of a fresh restore and on startup for a restore whose process died.
 */
export function buildSwapRecoveryScript(liveRoots: string[]): string {
	return `set -e; ${liveRoots.map(recoverOne).join('; ')}`;
}
