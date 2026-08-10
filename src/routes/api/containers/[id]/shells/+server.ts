import { json } from '@sveltejs/kit';
import { execInContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

// Shell paths to check
const SHELLS_TO_CHECK = [
	{ path: '/bin/bash', label: 'Bash' },
	{ path: '/bin/sh', label: 'Shell (sh)' },
	{ path: '/bin/zsh', label: 'Zsh' },
	{ path: '/bin/ash', label: 'Ash (Alpine)' }
];

/**
 * GET /api/containers/{id}/shells - Detect available shells in a container
 *
 * @openapi
 * summary: Probe a container for available shells (bash/sh/zsh/ash) and report the preferred default (requires the 'exec' permission)
 * description: On probe failure the endpoint still returns 200 with empty results rather than an error, so callers always get a usable shell list.
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: {shells:array<string>!, defaultShell:string, allShells:array<{path:string!, label:string!, available:boolean!}>!}
 * resp-200-example: {"shells":["/bin/sh"],"defaultShell":"/bin/sh","allShells":[{"path":"/bin/bash","label":"Bash","available":false},{"path":"/bin/sh","label":"Shell (sh)","available":true}]}
 * resp-403: Permission denied, or (enterprise) no access to the requested environment
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check - need exec permission to detect shells
	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const containerId = params.id;
		const shellNames = SHELLS_TO_CHECK.map(s => s.path.split('/').pop()!);
		const namedPaths = new Map<string, string>(); // name → resolved absolute path

		// Resolve each shell through the container's own PATH using `command -v`,
		// so that images with shells at non-standard locations (e.g. /usr/bin/sh
		// where /bin/sh isn't a symlink, or PATH ordering that shadows the
		// shell-builtin `test`) still report correctly. `exit 0` at the end
		// keeps the exec exit code clean even when some shells are absent —
		// otherwise execInContainer treats non-zero as a thrown error and the
		// valid output is discarded (issue #1189).
		const probe =
			`for s in ${shellNames.join(' ')}; do ` +
			`p=$(command -v $s 2>/dev/null) && [ -n "$p" ] && echo "$s:$p"; ` +
			`done; exit 0`;

		try {
			const output = await execInContainer(
				containerId,
				['sh', '-c', probe],
				envIdNum
			);

			for (const line of output.trim().split('\n').filter(Boolean)) {
				const colon = line.indexOf(':');
				if (colon < 0) continue;
				const name = line.slice(0, colon);
				const resolved = line.slice(colon + 1);
				if (resolved.startsWith('/')) namedPaths.set(name, resolved);
			}
		} catch {
			// `sh` itself was not invocable. Fall back to probing the canonical
			// paths directly with a non-shell-resolved test — exec each one
			// against its absolute path and rely on docker exec's own
			// "executable not found" failure to indicate absence. This handles
			// the rare image where there's no `sh` at all but bash exists.
			for (const shell of SHELLS_TO_CHECK) {
				try {
					await execInContainer(
						containerId,
						[shell.path, '-c', 'exit 0'],
						envIdNum
					);
					const name = shell.path.split('/').pop()!;
					namedPaths.set(name, shell.path);
				} catch {
					// Shell not available at this path; try the next.
				}
			}
		}

		const availableShells = Array.from(namedPaths.values());

		// Determine default shell - prefer bash, then sh, then first available
		let defaultShell: string | null = null;
		if (namedPaths.has('bash')) {
			defaultShell = namedPaths.get('bash')!;
		} else if (namedPaths.has('sh')) {
			defaultShell = namedPaths.get('sh')!;
		} else if (availableShells.length > 0) {
			defaultShell = availableShells[0];
		}

		return json({
			shells: availableShells,
			defaultShell,
			allShells: SHELLS_TO_CHECK.map(s => {
				const name = s.path.split('/').pop()!;
				const resolved = namedPaths.get(name);
				return {
					path: resolved ?? s.path,
					label: s.label,
					available: namedPaths.has(name)
				};
			})
		});
	} catch (error) {
		console.error('Error detecting shells:', error);
		return json({
			error: 'Failed to detect shells',
			shells: [],
			defaultShell: null,
			allShells: SHELLS_TO_CHECK.map(s => ({
				path: s.path,
				label: s.label,
				available: false
			}))
		}, { status: 200 }); // Return 200 with empty results rather than 500
	}
};
