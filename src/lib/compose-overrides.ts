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
