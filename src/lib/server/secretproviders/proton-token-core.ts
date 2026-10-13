/**
 * Shape check for a Proton Pass personal access token.
 *
 * pass-cli parses the token as `pst_<64 chars>::<base64url key>` and rejects
 * anything else with its own message on stderr, which Dockhand does not retain -
 * so a token with a typo surfaces as a bare "command failed". Checking the shape
 * here names the problem instead, and costs no process.
 *
 * Mirrors pass-auth/src/personal_access_token.rs (TOKEN_PREFIX, TOKEN_LENGTH_
 * WITHOUT_PREFIX, TOKEN_SEPARATOR). It is deliberately a FORMAT check only: it
 * cannot tell a well-formed token from an accepted one, which is the server's
 * answer to give.
 */

const TOKEN_PREFIX = 'pst_';
const TOKEN_SEPARATOR = '::';
const TOKEN_LENGTH_WITHOUT_PREFIX = 64;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Why a token cannot be used, or null when its shape is right. */
export function protonTokenFormatError(raw: string): string | null {
	if (!raw) return 'Proton Pass access token is empty';
	if (raw.includes('\0') || /\s/.test(raw)) {
		return 'Proton Pass access token is malformed: it contains whitespace or a control character';
	}

	const parts = raw.split(TOKEN_SEPARATOR);
	if (parts.length !== 2) {
		return `Proton Pass access token is malformed: expected the format ${TOKEN_PREFIX}<token>${TOKEN_SEPARATOR}<key>. Copy the whole token, including the part after "${TOKEN_SEPARATOR}".`;
	}

	const [token, key] = parts;
	if (!token.startsWith(TOKEN_PREFIX)) {
		return `Proton Pass access token is malformed: it must start with "${TOKEN_PREFIX}"`;
	}
	if (token.length - TOKEN_PREFIX.length !== TOKEN_LENGTH_WITHOUT_PREFIX) {
		return `Proton Pass access token is malformed: expected ${TOKEN_LENGTH_WITHOUT_PREFIX} characters after "${TOKEN_PREFIX}", got ${token.length - TOKEN_PREFIX.length}`;
	}
	if (!key || !BASE64URL_RE.test(key)) {
		return `Proton Pass access token is malformed: the key after "${TOKEN_SEPARATOR}" must be base64url (A-Z, a-z, 0-9, - and _)`;
	}
	return null;
}

/**
 * Causes we are willing to repeat from pass-cli's stderr, matched whole.
 *
 * An allow-list, not a filter: stderr can carry a vault item name, a path, or -
 * if the CLI fails mid-write - secret output, so anything not recognised here is
 * dropped rather than shown. Each entry is a fixed string pass-cli emits in its
 * `Caused by:` chain, verified against 2.4.1.
 */
const KNOWN_CAUSES = [
	'This personal access token is invalid, expired or has been deleted.',
	'Personal access token token not found. Set PROTON_PASS_PERSONAL_ACCESS_TOKEN environment variable',
	'Invalid personal access token token format. Expected format: pst_<token>::<key>',
	'Already authenticated'
] as const;

/**
 * The reason a pass-cli command failed, when it is one we recognise.
 *
 * The exit code alone says nothing, and the cause pass-cli reports is what tells
 * an expired token apart from a network problem. Only the known causes above are
 * repeated, so no unrecognised stderr content can reach a user-facing message.
 */
export function passCliFailureReason(stderr: string): string | null {
	return KNOWN_CAUSES.find((cause) => stderr.includes(cause)) ?? null;
}
