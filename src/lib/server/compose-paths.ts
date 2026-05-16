export const DEFAULT_COMPOSE_PATH = 'compose.yaml';

export function normalizeComposePaths(paths: unknown, fallback = DEFAULT_COMPOSE_PATH): string[] {
	let values: unknown[];
	if (Array.isArray(paths)) {
		values = paths;
	} else if (typeof paths === 'string') {
		values = [paths];
	} else {
		values = [fallback];
	}

	const normalized = values
		.filter((path): path is string => typeof path === 'string')
		.map(path => path.trim())
		.filter(Boolean);
	return normalized.length > 0 ? normalized : [fallback || DEFAULT_COMPOSE_PATH];
}
