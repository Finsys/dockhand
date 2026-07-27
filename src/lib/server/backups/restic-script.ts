/**
 * backups/restic-script.ts — pure helpers for building the shell command a
 * restic helper container runs, and reading its exit code back. No I/O, no DB,
 * no docker — so these are unit-testable in isolation (the Restic class in
 * ./restic that uses them is the side-effecting edge).
 *
 * Why an exit marker instead of relying on the container's exit code: restic's
 * `backup` exit code 3 ("could not read all source files") is a partial-but-
 * valid outcome we must be able to see as a warning rather than a hard failure.
 * The helper script captures restic's real exit code and prints it as its final
 * stdout line; the caller reads it back. The container's own shell always exits
 * 0 so the docker layer doesn't treat a mere restic non-zero as a helper crash.
 */

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
 * Wrap a command so it runs, captures its exit code, and prints the exit marker
 * as the FINAL stdout line — regardless of success or failure. The command runs
 * WITHOUT `set -e` so a restic non-zero (e.g. exit 3) doesn't abort before the
 * marker is printed.
 *
 * CONSTRAINT: `command` must RETURN its status (which restic and `sh -c '...'`
 * do), not terminate the shell with a bare `exit N` — a bare exit ends the whole
 * script before the marker line runs, and the caller would then read `undefined`
 * (treated as an unknown-outcome failure). When composing a multi-step session
 * script, wrap a step whose failure must be caught in a subshell `( ... )` or
 * `sh -c '...'` rather than letting `set -e` / `exit` end the wrapper.
 */
export function finishScript(command: string): string {
	return `${command}; __rc=$?; echo "${EXIT_MARKER}\${__rc}"`;
}

/**
 * Read the restic exit code from a helper's stdout (the EXIT_MARKER line, read
 * from the end so trailing output wins). Returns undefined if the marker is
 * absent — meaning the script did not run to completion (killed / crashed),
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
 * Build the bind list for a restic helper: the caller's volume binds, plus — for
 * a local (filesystem) repository only — the repo path bind so restic can reach
 * it. `resolveLocalRepoHostPath` maps the in-container repo path to a host path.
 */
export function buildHelperBinds(
	repository: string,
	volumeBinds: string[],
	resolveLocalRepoHostPath: (repoPath: string) => string
): string[] {
	const binds = [...volumeBinds];
	if (repository.startsWith('/')) {
		binds.push(`${resolveLocalRepoHostPath(repository)}:${repository}`);
	}
	return binds;
}
