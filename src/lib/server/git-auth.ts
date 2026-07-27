/**
 * Pure HTTPS git auth helpers. Kept dependency-free (no ../db, no ./stacks) so it
 * loads under `bun test` without dragging in better-sqlite3 / Docker.
 */

/**
 * Build the HTTP Basic `Authorization` header value for HTTPS token auth.
 *
 * GitHub rejects a Basic header with an EMPTY username (base64(":token")) with a
 * 401, and git then falls back to an interactive prompt, failing with "could not
 * read Username ... terminal prompts disabled" (#1273). Token auth doesn't need a
 * real username, so an empty username defaults to GitHub's documented placeholder
 * `x-access-token` — accepted by GitHub, while Gitea ignores the username field
 * entirely, so this is safe. A user-supplied username is always preserved.
 */
export function buildBasicAuthHeader(username: string, token: string): string {
	const user = username || 'x-access-token';
	const basicAuth = Buffer.from(`${user}:${token}`).toString('base64');
	return `Authorization: Basic ${basicAuth}`;
}
