/**
 * Pure helpers for the SOPS provider (no process spawning, no I/O), split out so
 * they can be unit-tested without importing the server modules.
 *
 * SOPS encrypts a dotenv file value by value and appends its own metadata as
 * `sops_*` lines. Only files in that shape are handed to the CLI; a plain env file
 * bound to a SOPS provider is left alone, exactly as before the provider existed.
 */

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Every SOPS dotenv file carries both of these; a hand-written env file practically
// never does. Anchored to a line start so a value that merely mentions them is no match.
const SOPS_MAC_RE = /^sops_mac=/m;
const SOPS_VERSION_RE = /^sops_version=/m;

// age X25519 identity, as printed by `age-keygen`: Bech32, upper case. Not anchored
// to a line: a password input collapses a pasted keys.txt onto one line.
const AGE_IDENTITY_RE = /AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}(?![0-9A-Z])/g;

/** True when `content` is a SOPS-encrypted dotenv file. */
export function isSopsDotenv(content: string | undefined | null): content is string {
	if (!content) return false;
	return SOPS_MAC_RE.test(content) && SOPS_VERSION_RE.test(content);
}

/** True when an env value is a single SOPS ciphertext (`ENC[AES256_GCM,...]`). */
export function isSopsCiphertext(value: unknown): boolean {
	return typeof value === 'string' && /^ENC\[AES256_GCM,data:.*\]$/s.test(value.trim());
}

/**
 * Normalises the configured age key(s) into the newline-separated form SOPS reads
 * from `SOPS_AGE_KEY`. Accepts a bare `AGE-SECRET-KEY-1...` or the whole `keys.txt`
 * written by `age-keygen` - its comments (creation date, public key) are not
 * identities and are left out - so pasting either works. Throws when no identity
 * is found, without echoing the input.
 */
export function normalizeAgeIdentities(raw: unknown): string {
	if (typeof raw !== 'string' || !raw.trim()) throw new Error('SOPS age key is required');
	const identities = [...new Set(raw.match(AGE_IDENTITY_RE) ?? [])];
	if (identities.length === 0) {
		throw new Error('SOPS age key must contain at least one AGE-SECRET-KEY-1... identity');
	}
	return identities.join('\n');
}

/**
 * Merges a decrypted env file into the resolver's maps, in place. Decrypted values
 * become secrets (shell env, never disk) underneath explicit DB secrets and DB
 * overrides. A DB non-secret that is still ciphertext is no override - the restore
 * path passes the env file itself in as non-secrets - so it is dropped instead,
 * and the ciphertext never reaches compose in place of the value. Returns how many
 * values were injected.
 */
export function mergeDecryptedEnvFile(
	decrypted: Record<string, string>,
	dbNonSecretVars: Record<string, string>,
	secretVars: Record<string, string>
): number {
	let injected = 0;
	for (const [key, value] of Object.entries(decrypted)) {
		if (key in dbNonSecretVars && isSopsCiphertext(dbNonSecretVars[key])) delete dbNonSecretVars[key];
		if (key in secretVars || key in dbNonSecretVars) continue;
		secretVars[key] = value;
		injected++;
	}
	return injected;
}

/**
 * Strips ONE layer of matching surrounding quotes. SOPS's dotenv format keeps a
 * value's quotes as part of the value, while Compose strips them when it reads an
 * env file - so `PASSWORD="a b"` would otherwise reach the container with the
 * quotes. Unlike stripSurroundingQuotes in ./shared, whitespace is kept: it is
 * part of the secret.
 */
function stripMatchingQuotes(value: string): string {
	return value.replace(/^(["'])(.*)\1$/s, '$2');
}

/**
 * Parses the JSON that `sops decrypt --input-type dotenv --output-type json`
 * prints into a flat env map. SOPS has already left its `sops_*` metadata out.
 * Keys that are not valid env-var names are skipped (with their name reported,
 * never their value) rather than failing the whole file.
 */
export function parseSopsDecryptOutput(stdout: string): { vars: Record<string, string>; skipped: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error('SOPS returned output that is not JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('SOPS returned output that is not a key/value map');
	}
	const vars = Object.create(null) as Record<string, string>;
	const skipped: string[] = [];
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!ENV_NAME_RE.test(key) || DANGEROUS_KEYS.has(key) || typeof value !== 'string' || value.includes('\0')) {
			skipped.push(key);
			continue;
		}
		vars[key] = stripMatchingQuotes(value);
	}
	return { vars, skipped };
}
