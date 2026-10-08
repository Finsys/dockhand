export const STANDARD_COMPOSE_OVERRIDE_FILENAMES = [
	'compose.override.yml',
	'compose.override.yaml',
	'docker-compose.override.yml',
	'docker-compose.override.yaml'
] as const;

export function detectedComposeOverridePaths(composePath: string, entryNames: string[]): string[] {
	const directoryPrefix = composePath.slice(0, composePath.lastIndexOf('/') + 1);
	const entries = new Set(entryNames);
	return STANDARD_COMPOSE_OVERRIDE_FILENAMES
		.filter((name) => entries.has(name))
		.map((name) => `${directoryPrefix}${name}`)
		.filter((path) => path !== composePath);
}

/**
 * List the compose file's directory through a file-browser API and return the standard
 * override files found beside it. `rootDirectory` is listed for a top-level compose path.
 */
export async function fetchDetectedComposeOverridePaths(browseApiUrl: string, composePath: string, rootDirectory: string): Promise<string[]> {
	const slash = composePath.lastIndexOf('/');
	const composeDir = slash <= 0 ? rootDirectory : composePath.slice(0, slash);
	const response = await fetch(`${browseApiUrl}${browseApiUrl.includes('?') ? '&' : '?'}path=${encodeURIComponent(composeDir)}`);
	if (!response.ok) return [];
	const data: { entries?: unknown } = await response.json();
	const entries: Array<{ name: string; type?: string }> = Array.isArray(data.entries) ? data.entries : [];
	return detectedComposeOverridePaths(
		composePath,
		entries.filter((entry) => entry.type !== 'directory').map((entry) => entry.name)
	);
}
