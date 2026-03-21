import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { execInContainer, getContainerTop } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

function parsePsOutput(output: string): { Titles: string[]; Processes: string[][] } | null {
	const lines = output.trim().split('\n').filter(line => line.trim());
	if (lines.length === 0) return null;

	const headerLine = lines[0];
	const headers = headerLine.trim().split(/\s+/);

	// Find the index of COMMAND (last column, can have spaces)
	const commandIndex = headers.findIndex(h => h === 'COMMAND' || h === 'CMD');

	const processes = lines.slice(1).map(line => {
		const parts = line.trim().split(/\s+/);
		// COMMAND can have spaces, so join everything from commandIndex onwards
		if (commandIndex !== -1 && parts.length > commandIndex) {
			const beforeCommand = parts.slice(0, commandIndex);
			const command = parts.slice(commandIndex).join(' ');
			return [...beforeCommand, command];
		}
		return parts;
	});

	return { Titles: headers, Processes: processes };
}

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (process list uses inspect permission)
	if (auth.authEnabled && !await auth.can('containers', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		// Try different ps commands in order of preference
		const psCommands = [
			['ps', 'aux', '--sort=-pcpu'],  // GNU ps with CPU sort
			['ps', 'aux'],                   // GNU ps without sort
			['ps', '-ef'],                   // POSIX ps
		];

		for (const cmd of psCommands) {
			try {
				const output = await execInContainer(params.id, cmd, envIdNum);
				// Check if output looks like an error message (BusyBox error, etc.)
				if (output.includes('unrecognized option') || output.includes('Usage:') || output.includes('BusyBox')) {
					continue;
				}
				const result = parsePsOutput(output);
				if (result && result.Processes.length > 0) {
					return json({ ...result, source: 'ps' });
				}
			} catch {
				// Try next command
			}
		}

		// Fallback to docker top API
		const top = await getContainerTop(params.id, envIdNum);
		return json({ ...top, source: 'top' });
	} catch (error: any) {
		console.error('Failed to get container processes:', error);
		return json({ error: error.message || 'Failed to get processes' }, { status: 500 });
	}
};
