/**
 * Pure helpers for how `docker compose` is told which daemon to talk to.
 *
 * The daemon MUST be passed via the `docker -H` CLI flag, NOT via DOCKER_HOST in the
 * spawn env: shell env leaks into services that pass through (`- DOCKER_HOST`) or
 * interpolate (`${DOCKER_HOST}`) that variable - e.g. a socket-proxy sidecar -
 * overriding the value the stack set for itself (#1393). `-H` connects compose to the
 * right daemon without polluting the compose interpolation env. Kept dependency-free
 * so it unit-tests without spinning up the stack machinery.
 */

/**
 * Resolves the daemon endpoint for a compose invocation: the per-environment
 * dockerHost if given, else Dockhand's own DOCKER_HOST (socket-proxy setups), else
 * undefined (plain local socket - compose uses the default). `ownDockerHost` is
 * `process.env.DOCKER_HOST` (passed in so the resolver stays pure/testable).
 */
export function resolveComposeDockerHost(
	dockerHost: string | undefined | null,
	ownDockerHost: string | undefined | null
): string | undefined {
	return dockerHost || ownDockerHost || undefined;
}

/**
 * Builds the argv for `docker compose`, putting the daemon on the GLOBAL `-H` flag
 * (before `compose`) so it never enters the shell env. Returns the base args; callers
 * append the compose subcommand + flags.
 */
export function buildComposeBaseArgs(
	stackName: string,
	composeDockerHost: string | undefined
): string[] {
	return composeDockerHost
		? ['docker', '-H', composeDockerHost, 'compose', '-p', stackName]
		: ['docker', 'compose', '-p', stackName];
}
