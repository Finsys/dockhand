import { json } from '@sveltejs/kit';
import { execInContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

// Shell paths to check
const SHELLS_TO_CHECK = [
	{ path: '/bin/bash', label: 'Bash' },
	{ path: '/bin/sh', label: 'Shell (sh)' },
	{ path: '/bin/zsh', label: 'Zsh' },
	{ path: '/bin/ash', label: 'Ash (Alpine)' }
];

export const GET: RequestHandler = async ({ params, url, cookies }) => {
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
		const availableShells: string[] = [];

		// Check each shell by testing if the file exists and is executable
		// Use a single command to check all shells at once for efficiency
		const checkCommand = SHELLS_TO_CHECK.map(s =>
			`test -x ${s.path} && echo "${s.path}"`
		).join('; ');

		try {
			const output = await execInContainer(
				containerId,
				['sh', '-c', checkCommand],
				envIdNum
			);

			// Parse output - each line is an available shell path
			const lines = output.trim().split('\n').filter(Boolean);
			availableShells.push(...lines);
		} catch {
			// If even sh fails, try checking with test commands individually
			// This handles edge cases where sh might not be available
			for (const shell of SHELLS_TO_CHECK) {
				try {
					await execInContainer(
						containerId,
						['test', '-x', shell.path],
						envIdNum
					);
					availableShells.push(shell.path);
				} catch {
					// Shell not available, continue to next
				}
			}
		}

		// Determine default shell - prefer bash, then sh, then first available
		let defaultShell: string | null = null;
		if (availableShells.includes('/bin/bash')) {
			defaultShell = '/bin/bash';
		} else if (availableShells.includes('/bin/sh')) {
			defaultShell = '/bin/sh';
		} else if (availableShells.length > 0) {
			defaultShell = availableShells[0];
		}

		return json({
			shells: availableShells,
			defaultShell,
			allShells: SHELLS_TO_CHECK.map(s => ({
				path: s.path,
				label: s.label,
				available: availableShells.includes(s.path)
			}))
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
