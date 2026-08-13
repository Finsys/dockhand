/**
 * Pure builders for the restic helper container's shell command + reading its
 * exit code back. The exit marker preserves restic's real code (esp. exit 3 =
 * partial backup, a warning not a failure) since the helper's shell always
 * exits 0 so docker doesn't treat a restic non-zero as a crash.
 */

import { isLocalRepo } from './models';

/** The marker line the helper prints carrying restic's real exit code. */
export const EXIT_MARKER = 'DOCKHAND_RESTIC_EXIT=';

/** Quote a single argument for safe interpolation into an `sh -c` string. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the `restic <args...>` command string, each arg shell-quoted. */
export function resticCommand(args: string[]): string {
	return `restic ${args.map(shellQuote).join(' ')}`;
}

/**
 * Append the exit marker after `command` so the caller reads its real code.
 * GOTCHA: `command` must RETURN its status, not `exit N` - a bare exit ends the
 * script before the marker prints, and the caller reads `undefined` (= failure).
 * Wrap a step that might `exit`/`set -e` in a subshell `( ... )`.
 */
export function finishScript(command: string): string {
	return `${command}; __rc=$?; echo "${EXIT_MARKER}\${__rc}"`;
}

/** Where the helper writes the GCS service-account JSON before restic reads it. */
export const GCS_CRED_FILE = '/tmp/dockhand-gcs-sa.json';

/**
 * restic's GCS backend authenticates with a service-account JSON file whose path
 * is in GOOGLE_APPLICATION_CREDENTIALS (it auto-refreshes the token). We pass the
 * JSON CONTENT as the GOOGLE_APPLICATION_CREDENTIALS_JSON env var; this preamble
 * (prepended to the helper's `sh -c` script, in the SAME shell as restic) writes
 * it to a 0600 file and exports GOOGLE_APPLICATION_CREDENTIALS at that path.
 *
 * A no-op when the var is empty/unset, so S3/B2/Azure/local repos are untouched.
 * `printf %s` avoids the JSON being mangled by echo's escape handling.
 */
export function gcsCredentialPreamble(): string {
	return `if [ -n "\${GOOGLE_APPLICATION_CREDENTIALS_JSON:-}" ]; then umask 077; printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS_JSON" > ${GCS_CRED_FILE}; export GOOGLE_APPLICATION_CREDENTIALS=${GCS_CRED_FILE}; fi; `;
}

/**
 * Fail loud if a bind-mounted local repo isn't visible on the target daemon's
 * host: Docker would auto-create the missing path empty, silently backing up to
 * the wrong host. '' for non-local repos (they never bind a path).
 */
export function localRepoGuard(repository: string): string {
	if (!isLocalRepo(repository)) return '';
	const msg = `restic repository not found at $RESTIC_REPOSITORY on this environment's Docker host. A local-path repository only works when the environment's Docker daemon runs on the same host as Dockhand (e.g. a co-located socket-proxy). For a remote host, use an S3 or REST destination.`;
	return `test -f "$RESTIC_REPOSITORY/config" || { echo ${shellQuote(msg)} >&2; exit 1; }; `;
}

/**
 * The helper runs as root (it must read root-owned source volumes), so it writes
 * the repo files as root. The main Dockhand process reads the repo as its own
 * (su-exec'd) uid, so for a LOCAL-path repo it couldn't read root-owned files
 * ("snapshot not found"). Re-own the repo to the main process's uid:gid after the
 * op so subsequent local reads work. Best-effort (`|| true`) and appended AFTER the
 * exit marker, so it never changes restic's real exit code. '' for non-local repos
 * (no bind, nothing to chown) and when ownerSpec is empty.
 * Note: this only re-owns the repo FILES; the ownership of the BACKED-UP data lives
 * in snapshot metadata and is untouched (restore fidelity is preserved).
 */
export function localRepoChown(repository: string, ownerSpec: string): string {
	if (!ownerSpec) return '';
	if (!isLocalRepo(repository)) return '';
	return `; chown -R ${ownerSpec} "$RESTIC_REPOSITORY" 2>/dev/null || true`;
}

/**
 * Read the restic exit code from a helper's stdout (the EXIT_MARKER line, read
 * from the end so trailing output wins). Returns undefined if the marker is
 * absent - meaning the script did not run to completion (killed / crashed),
 * i.e. an unknown outcome the caller must treat as failure.
 */
export function readExitMarker(stdout: string): number | undefined {
	const lines = stdout.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.startsWith(EXIT_MARKER)) {
			const n = Number(line.slice(EXIT_MARKER.length));
			return Number.isInteger(n) ? n : undefined;
		}
	}
	return undefined;
}

/**
 * Classify a spawned restic process's `close` event into the fail-closed exit/stderr
 * contract, independent of how stdout was captured (string or Buffer). A timeout kill
 * gives `code === null` + a signal, which maps to `exitCode: undefined` (unknown
 * outcome = failure for the caller), and the killing signal is appended to stderr so
 * it is visible in diagnostics.
 */
export function classifyProcClose(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr: string
): { exitCode: number | undefined; stderr: string } {
	const exitCode = code === null ? undefined : code;
	const stderrOut = signal ? `${stderr}\n(process killed by ${signal})` : stderr;
	return { exitCode, stderr: stderrOut };
}

/**
 * Classify a spawn `error` (restic missing / not spawnable): a real failure surfaced
 * as data with `exitCode: undefined` (never thrown), the error message appended to
 * stderr so the caller sees why.
 */
export function classifyProcError(
	err: Error,
	stderr: string
): { exitCode: undefined; stderr: string } {
	return { exitCode: undefined, stderr: `${stderr}\n${err.message}` };
}

/**
 * Build the KEY=value env array for a restic helper container: repo + password
 * + a progress-rate hint, plus the cloud credentials that survive the allowlist.
 * `allowedCloudVars` is the already-filtered cloud map (the caller passes
 * filterCloudEnvVars(...) so this stays pure and unit-testable).
 */
export function buildHelperEnv(
	repository: string,
	password: string,
	allowedCloudVars: Record<string, string>
): string[] {
	const env = [
		`RESTIC_REPOSITORY=${repository}`,
		`RESTIC_PASSWORD=${password}`,
		'RESTIC_PROGRESS_FPS=2',
	];
	for (const [k, v] of Object.entries(allowedCloudVars)) env.push(`${k}=${v}`);
	return env;
}

/**
 * Build the bind list for a restic helper: the caller's volume binds, plus - for
 * a local (filesystem) repository only - the repo path bind so restic can reach
 * it. `resolveLocalRepoHostPath` maps the in-container repo path to a host path.
 */
export function buildHelperBinds(
	repository: string,
	volumeBinds: string[],
	resolveLocalRepoHostPath: (repoPath: string) => string
): string[] {
	const binds = [...volumeBinds];
	if (isLocalRepo(repository)) {
		binds.push(`${resolveLocalRepoHostPath(repository)}:${repository}`);
	}
	return binds;
}
