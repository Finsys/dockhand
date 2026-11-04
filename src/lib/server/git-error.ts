/**
 * Pure git error-message helpers, split out of git.ts so they can be unit-tested
 * without importing git.ts's heavy deps (db/docker). No I/O here.
 */

export function isSshRepoUrl(url: string | null | undefined): boolean {
	const u = (url || '').trim();
	if (!u) return false;
	if (u.startsWith('git@') || u.startsWith('ssh://')) return true;
	const schemeMatch = u.match(/^[a-z][a-z0-9+.-]*:/i);
	if (schemeMatch) {
		return schemeMatch[0].slice(0, -1).toLowerCase() === 'ssh';
	}
	const colonIdx = u.indexOf(':');
	return colonIdx > 0;
}

/**
 * The permission-denied message, tailored to the auth in use (#1509, #1862). A token/password
 * credential paired with an SSH URL (git@... or ssh://...) is the common trap: git uses the SSH
 * transport and cannot take passwords non-interactively, so it fails with a public-key error - blaming
 * "SSH credentials" then is actively misleading. Point at the real cause instead.
 */
export function permissionDeniedMessage(
	authType?: string | null,
	url?: string | null
): string {
	const isSsh = isSshRepoUrl(url);
	if (authType === 'password') {
		if (isSsh) {
			return 'Permission denied. Password/token authentication is not supported with SSH repository URLs (ssh:// or git@...). Use an SSH key credential or switch the repository URL to https://.';
		}
		return 'Permission denied. Check your access token and that it has repository access.';
	}
	if (authType === 'ssh') {
		return 'Permission denied. Check your SSH key and that it is authorized for this repository.';
	}
	return 'Permission denied. Check your credentials.';
}
