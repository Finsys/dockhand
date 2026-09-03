/**
 * Pure git error-message helpers, split out of git.ts so they can be unit-tested
 * without importing git.ts's heavy deps (db/docker). No I/O here.
 */

/**
 * The permission-denied message, tailored to the auth in use (#1509). A token/password
 * credential paired with an `git@...` SSH URL is the common trap: git uses the SSH
 * transport and never applies the token, so it fails with a public-key error - blaming
 * "SSH credentials" then is actively misleading. Point at the real cause instead.
 */
export function permissionDeniedMessage(
	authType?: string | null,
	url?: string | null
): string {
	const isSshUrl = !!url && url.startsWith('git@');
	if (authType === 'password') {
		if (isSshUrl) {
			return 'Permission denied. This credential uses a token, but the repository URL is an SSH URL (git@...). Use an https:// URL for token authentication.';
		}
		return 'Permission denied. Check your access token and that it has repository access.';
	}
	if (authType === 'ssh') {
		return 'Permission denied. Check your SSH key and that it is authorized for this repository.';
	}
	return 'Permission denied. Check your credentials.';
}
