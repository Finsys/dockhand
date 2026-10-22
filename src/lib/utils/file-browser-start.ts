// Where the container file browser opens: the image/container WORKDIR, else root (#1285).
// Docker stores WorkingDir absolute; anything relative or odd falls back to '/'.
export function fileBrowserStartPath(workingDir: unknown): string {
	if (typeof workingDir !== 'string') return '/';
	const trimmed = workingDir.trim();
	if (!trimmed.startsWith('/')) return '/';
	const parts = trimmed.split('/').filter((p) => p && p !== '.');
	if (parts.includes('..')) return '/';
	return '/' + parts.join('/');
}
