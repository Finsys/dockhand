import { posix as posixPath } from 'node:path';

export const DEFAULT_COMPOSE_PATH = 'compose.yaml';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function normalizeComposePath(path: string): string {
	return posixPath.normalize(path.trim().replace(/\\/g, '/'));
}

export function normalizeComposePaths(paths: unknown, fallback = DEFAULT_COMPOSE_PATH): string[] {
	let values: unknown[];
	if (Array.isArray(paths)) {
		values = paths;
	} else if (typeof paths === 'string') {
		values = paths.split(/[\n\r,]+/);
	} else {
		values = [fallback];
	}

	const normalized = values
		.filter((path): path is string => typeof path === 'string')
		.map(path => path.trim())
		.filter(Boolean)
		.map(normalizeComposePath);
	return normalized.length > 0 ? normalized : [fallback || DEFAULT_COMPOSE_PATH];
}

function isParentTraversal(path: string): boolean {
	return path === '..' || path.startsWith('../') || path.includes('/../');
}

function sentenceCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function getComposePathsValidationError(
	paths: readonly string[],
	pathLabel = 'compose file path'
): string | null {
	const capitalizedPathLabel = sentenceCase(pathLabel);
	if (paths.length === 0) {
		return `At least one ${pathLabel} is required`;
	}

	const blankPath = paths.find(path => path.trim().length === 0);
	if (blankPath !== undefined) {
		return `${capitalizedPathLabel} cannot be blank`;
	}

	const currentDirectoryPath = paths.find(path => normalizeComposePath(path) === '.');
	if (currentDirectoryPath) {
		return `${capitalizedPathLabel} must reference a file path: ${currentDirectoryPath}`;
	}

	const absolutePath = paths.find(path => {
		const normalizedPath = normalizeComposePath(path);
		return normalizedPath.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(normalizedPath);
	});
	if (absolutePath) {
		return `${capitalizedPathLabel} must be a relative path inside the repository: ${absolutePath}`;
	}

	const traversalPath = paths.find(path => isParentTraversal(normalizeComposePath(path)));
	if (traversalPath) {
		return `${capitalizedPathLabel} cannot contain parent directory traversal: ${traversalPath}`;
	}

	return null;
}

export function assertValidComposePaths(paths: readonly string[], pathLabel = 'compose file path'): void {
	const error = getComposePathsValidationError(paths, pathLabel);
	if (error) {
		throw new Error(error);
	}
}
