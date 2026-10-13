/**
 * Pure helpers for the Psono provider: the two-step decryption and the inline
 * reference syntax. No network, no db, no docker. The unit tests seal their own
 * fixtures the way Psono seals one; the live-server proof is the integration test.
 *
 * Psono hands out a secret as two secretbox-sealed blobs. The first holds the
 * secret's own key, sealed under the API key's secret key; the second holds the
 * content, sealed under that key. Both arrive hex-encoded.
 */

import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';

/** A secret as `POST /api-key-access/secret/` returns it (local-decryption mode). */
export interface PsonoEncryptedSecret {
	data: string;
	data_nonce: string;
	secret_key: string;
	secret_key_nonce: string;
}

/** What `POST /api-key-access/inspect/` says about a key and what it grants. */
export interface PsonoKeyInspection {
	restrict_to_secrets?: boolean;
	allow_insecure_access?: boolean;
	read?: boolean;
	write?: boolean;
	api_key_secrets?: { secret_id: string }[];
}

const HEX = /^[0-9a-f]*$/i;

function fromHex(value: string, what: string): Uint8Array {
	const hex = value?.trim() ?? '';
	// An odd length or a stray character means the server did not send what we
	// think it did; failing here beats handing garbage to the cipher.
	if (!hex || hex.length % 2 !== 0 || !HEX.test(hex)) {
		throw new Error(`Psono: ${what} is not valid hex`);
	}
	return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Opens one secretbox, naming what failed rather than leaking the bytes. */
function open(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, what: string): Uint8Array {
	if (key.length !== 32) throw new Error(`Psono: ${what} key must be 32 bytes`);
	if (nonce.length !== 24) throw new Error(`Psono: ${what} nonce must be 24 bytes`);
	try {
		return xsalsa20poly1305(key, nonce).decrypt(box);
	} catch {
		// Authentication failure: a wrong API key secret, or a tampered payload.
		throw new Error(`Psono: could not decrypt the ${what} - check the API key secret`);
	}
}

/**
 * Decrypts a secret into its plaintext JSON.
 *
 * The first open yields the secret's key as HEX TEXT, not as raw bytes, so it is
 * decoded again before the second open. Skipping that is the classic way to get a
 * "key must be 32 bytes" error on a payload that is perfectly fine.
 */
export function decryptSecret(secret: PsonoEncryptedSecret, apiKeySecretKey: string): unknown {
	const apiKey = fromHex(apiKeySecretKey, 'API key secret');
	const keyText = open(
		apiKey,
		fromHex(secret.secret_key_nonce, 'secret key nonce'),
		fromHex(secret.secret_key, 'secret key'),
		'secret key'
	);
	const contentKey = fromHex(new TextDecoder().decode(keyText), 'decrypted secret key');
	const plain = open(
		contentKey,
		fromHex(secret.data_nonce, 'data nonce'),
		fromHex(secret.data, 'data'),
		'secret content'
	);
	try {
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		throw new Error('Psono: the decrypted secret is not JSON');
	}
}

/**
 * The fields a Psono secret can carry a value in, by secret type. Psono stores a
 * type's fields under its own prefix, and the sessionless response does not say
 * which type it is, so the type is inferred from which keys are present.
 */
const VALUE_FIELDS = [
	'website_password_password',
	'application_password_password',
	'note_notes',
	'bookmark_url',
	'credit_card_number',
	'ssh_own_key_private',
	'elster_certificate_password',
	'totp_code'
] as const;

/** The field holding a secret's NAME, used when a bulk pull needs a variable name. */
const TITLE_FIELDS = [
	'website_password_title',
	'application_password_title',
	'note_title',
	'bookmark_title',
	'credit_card_title',
	'ssh_own_key_title',
	'elster_certificate_title',
	'totp_title'
] as const;

/** The field holding a username, which a bulk pull uses as the variable name. */
const USERNAME_FIELDS = [
	'website_password_username',
	'application_password_username'
] as const;

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'string' && v !== '') return v;
	}
	return null;
}

/**
 * One named value from a decrypted secret, for a bulk pull.
 *
 * A Psono secret is a record with a title, not a key/value pair, so a bulk pull has
 * to pick a name. The username field is preferred because that is where somebody
 * storing an env var puts its name (`DB_PASSWORD` / the value); the title is the
 * fallback. A secret with no value field is skipped rather than exported empty.
 */
export function secretToEnvVar(
	decrypted: unknown
): { name: string; value: string } | null {
	if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
	const obj = decrypted as Record<string, unknown>;
	const value = firstString(obj, VALUE_FIELDS);
	if (value === null) return null;
	const name = firstString(obj, USERNAME_FIELDS) ?? firstString(obj, TITLE_FIELDS);
	if (name === null) return null;
	const envName = toEnvVarName(name);
	return envName ? { name: envName, value } : null;
}

/**
 * A Psono title turned into a usable env-var name.
 *
 * Titles are free text ("Prod DB password"), so anything that cannot appear in a
 * shell variable becomes an underscore and the result is upper-cased. A name that
 * would start with a digit is prefixed, since `2FA=x` is not assignable.
 */
export function toEnvVarName(title: string): string | null {
	const cleaned = title
		.trim()
		.replace(/[^A-Za-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toUpperCase();
	if (!cleaned) return null;
	return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** A reference's shape: `psono://<secret_id>` or `psono://<secret_id>/<field>`. */
export interface PsonoReference {
	secretId: string;
	/** The field to read, or null to let secretToEnvVar pick the value field. */
	field: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a Psono inline reference. */
export function isPsonoReference(value: unknown): value is string {
	return typeof value === 'string' && parsePsonoReference(value) !== null;
}

/**
 * Parses `psono://<secret_id>[/<field>]`.
 *
 * The id must be a UUID: a restricted API key addresses secrets by id, and
 * accepting anything else would turn a typo into a request the server answers with
 * a deliberately ambiguous "no permission or does not exist".
 */
export function parsePsonoReference(value: string): PsonoReference | null {
	if (typeof value !== 'string') return null;
	// A compose file or .env often quotes a value; the quotes are the file's syntax,
	// not part of the reference, so a quoted ref must resolve like a bare one.
	const trimmed = value.trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
	if (!trimmed.toLowerCase().startsWith('psono://')) return null;
	const rest = trimmed.slice('psono://'.length);
	if (!rest) return null;
	const slash = rest.indexOf('/');
	const secretId = slash === -1 ? rest : rest.slice(0, slash);
	const field = slash === -1 ? null : rest.slice(slash + 1);
	if (!UUID.test(secretId)) return null;
	if (field !== null && (field === '' || field.includes('/'))) return null;
	return { secretId, field };
}

/** The value a reference asks for, or null when the secret does not carry it. */
export function referenceValue(decrypted: unknown, field: string | null): string | null {
	if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
	const obj = decrypted as Record<string, unknown>;
	if (field === null) {
		const v = firstString(obj, VALUE_FIELDS);
		return v;
	}
	const v = obj[field];
	return typeof v === 'string' ? v : null;
}

/**
 * Why a key's permissions are wrong for Dockhand, or null when they are fine.
 *
 * Checked at testConnection time so an over-privileged key is reported while an
 * administrator is still looking at the form. `allow_insecure_access` is the one
 * that matters most: it is what lets a caller send the master secret key to the
 * server, and Psono's own documentation discourages it.
 */
export function keyPermissionWarning(inspection: PsonoKeyInspection): string | null {
	if (inspection.read === false) {
		return 'The API key cannot read secrets. Enable read access on it in Psono.';
	}
	if (inspection.allow_insecure_access) {
		return 'The API key allows insecure access. Turn that off in Psono - Dockhand always decrypts locally and never sends the secret key to the server.';
	}
	if (inspection.write) {
		return 'The API key can write secrets. Dockhand only reads, so a read-only key is safer.';
	}
	if (inspection.restrict_to_secrets === false) {
		return 'The API key is not restricted to specific secrets, so it can reach the whole vault. A restricted key is safer.';
	}
	return null;
}

/** The secret ids an inspection grants, de-duplicated and validated. */
export function inspectedSecretIds(inspection: PsonoKeyInspection): string[] {
	const ids = (inspection.api_key_secrets ?? [])
		.map((e) => (typeof e?.secret_id === 'string' ? e.secret_id.trim() : ''))
		.filter((id) => UUID.test(id));
	return [...new Set(ids)];
}
