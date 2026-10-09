/**
 * Composing a restic `rest:` repository URL from separate fields.
 *
 * Shared by the destination form and the server: the form builds the URL, the server
 * redacts credentials out of restic's error output. Dependency-free so the browser can
 * import it.
 */

/**
 * Build a `rest:` repository URL from separate server / user / password fields.
 *
 * Hand-composing this URL is the source of three separate traps: a `%` or `@` in the
 * password has to be percent-encoded or restic refuses to parse the location at all, a
 * `rest:` typed into the field yields `rest:rest:http://...`, and restic masks the
 * password in its errors ONLY when it can parse the scheme - so a malformed URL prints
 * the credentials verbatim. Encoding the userinfo here means a password is never typed
 * into a URL.
 *
 * `server` may be given with or without a `rest:` prefix; either way exactly one is
 * emitted. Credentials already present in `server` are left alone when no explicit
 * user/password is supplied, so an existing destination round-trips unchanged.
 */
export function buildRestRepository(server: string, user?: string, password?: string): string {
	const bare = (server || '').trim().replace(/^rest:/, '');
	if (!bare) return '';
	if (!user && !password) return `rest:${bare}`;

	// The credentials go in as encoded userinfo, so any character is safe in a password.
	const userinfo = `${encodeURIComponent(user || '')}:${encodeURIComponent(password || '')}`;
	const schemeMatch = bare.match(/^(https?:\/\/)(.*)$/i);
	if (!schemeMatch) return `rest:${bare}`;
	// Drop any userinfo already in the host part; the explicit fields win.
	const rest = schemeMatch[2].replace(/^[^@/]*@/, '');
	return `rest:${schemeMatch[1]}${userinfo}@${rest}`;
}

/** Split a `rest:` repository back into its fields for the edit form, decoding userinfo. */
export function parseRestRepository(repository: string): { url: string; user: string; password: string } {
	const bare = (repository || '').replace(/^rest:/, '');
	const schemeMatch = bare.match(/^(https?:\/\/)([^@/]*)@(.*)$/i);
	if (!schemeMatch) return { url: bare, user: '', password: '' };
	const [rawUser, ...rawPassParts] = schemeMatch[2].split(':');
	const dec = (v: string) => {
		try { return decodeURIComponent(v); } catch { return v; }
	};
	return {
		url: `${schemeMatch[1]}${schemeMatch[3]}`,
		user: dec(rawUser || ''),
		password: dec(rawPassParts.join(':'))
	};
}

/**
 * Remove `user:password@` userinfo from every URL in a message.
 *
 * restic masks credentials itself, but only for a location it could parse - an
 * unparseable one is echoed whole. This message reaches the browser and is stored in
 * `backup_destinations.last_test_error`, which is not encrypted, so it must never
 * carry a password.
 */
export function redactUrlCredentials(message: string): string {
	if (!message) return message;
	// Any scheme, with userinfo that contains a colon: keep the user, drop the secret.
	return message.replace(
		/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]*)@/gi,
		(_m, scheme, user) => `${scheme}${user}:***@`
	);
}
