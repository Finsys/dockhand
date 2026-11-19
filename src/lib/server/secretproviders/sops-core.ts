/**
 * Pure helpers for the SOPS provider (no process spawning, no I/O), split out so
 * they can be unit-tested without importing the server modules.
 *
 * SOPS encrypts a dotenv file value by value and appends its own metadata as
 * `sops_*` lines. Only files in that shape are handed to the CLI; a plain env file
 * bound to a SOPS provider is left alone, exactly as before the provider existed.
 *
 * Nothing here logs: the decrypted values pass through these functions.
 */

import { expandValue, parseEnvFileForForm } from '../../utils/env-file-values';

// A `KEY=value` line as compose reads it, `export` prefix allowed.
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// Every SOPS dotenv file carries both of these; a hand-written env file practically
// never does. Anchored to a line start so a value that merely mentions them is no match.
const SOPS_MAC_RE = /^sops_mac=/m;
const SOPS_VERSION_RE = /^sops_version=/m;
const SOPS_METADATA_PREFIX = 'sops_';

// age identity as printed by `age-keygen` (X25519) or `age-keygen -pq` (post-quantum):
// Bech32, upper case. Not anchored to a line: a password input collapses a pasted
// keys.txt onto one line.
const AGE_IDENTITY_RE = /AGE-SECRET-KEY-(?:PQ-)?1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}(?![0-9A-Z])/g;
// Plugin identities (YubiKey, TPM, ...) need a plugin binary the image does not have.
const PLUGIN_IDENTITY_RE = /AGE-PLUGIN-[A-Z0-9-]+-1/;

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
 * The keys of a SOPS file whose values are encrypted. SOPS can leave some values in
 * the clear (`unencrypted_suffix` / `unencrypted_regex`); those are not secrets, and
 * compose already reads them from the file itself.
 */
export function sopsEncryptedKeys(content: string): Set<string> {
	const keys = new Set<string>();
	for (const line of content.split('\n')) {
		const match = ENV_LINE_RE.exec(line);
		if (match && !match[1].startsWith(SOPS_METADATA_PREFIX) && isSopsCiphertext(match[2])) keys.add(match[1]);
	}
	return keys;
}

/** The variable names an env file defines, read the way compose reads them. */
export function envFileKeys(content: string | undefined): Set<string> {
	const keys = new Set<string>();
	for (const line of (content ?? '').split('\n')) {
		const match = ENV_LINE_RE.exec(line);
		if (match) keys.add(match[1]);
	}
	return keys;
}

/**
 * A SOPS file's parsed vars without what only SOPS needs: its `sops_*` metadata and
 * values still encrypted. For the places that read the file as plain env (Hawser
 * merges it into the remote compose environment), where both would otherwise land.
 */
export function withoutSopsArtifacts(vars: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(vars)) {
		if (key.startsWith(SOPS_METADATA_PREFIX) || isSopsCiphertext(value)) continue;
		out[key] = value;
	}
	return out;
}

/**
 * An env file as the stack editor shows it: name to value, the way the form reads it.
 * In a SOPS file the `sops_*` lines are SOPS's own metadata, not the stack's variables,
 * so they are left out; the encrypted variables stay, under their names.
 */
export function envFileFormVars(content: string): Record<string, string> {
	const vars = Object.fromEntries(parseEnvFileForForm(content).map((row) => [row.key, row.value]));
	if (!isSopsDotenv(content)) return vars;
	return Object.fromEntries(Object.entries(vars).filter(([key]) => !key.startsWith(SOPS_METADATA_PREFIX)));
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
		if (PLUGIN_IDENTITY_RE.test(raw)) {
			throw new Error('SOPS age key: plugin identities (AGE-PLUGIN-...) are not supported');
		}
		throw new Error('SOPS age key must contain at least one AGE-SECRET-KEY-... identity');
	}
	return identities.join('\n');
}

/**
 * Merges a decrypted env file into the resolver's maps, in place. Decrypted values
 * become secrets (shell env, never disk) underneath explicit DB secrets and DB
 * overrides. Returns how many values were injected.
 */
export function mergeDecryptedEnvFile(
	decrypted: Record<string, string>,
	dbNonSecretVars: Record<string, string>,
	secretVars: Record<string, string>
): number {
	let injected = 0;
	for (const [key, value] of Object.entries(decrypted)) {
		if (Object.hasOwn(secretVars, key) || Object.hasOwn(dbNonSecretVars, key)) continue;
		secretVars[key] = value;
		injected++;
	}
	return injected;
}

/**
 * Parses what `sops decrypt --input-type dotenv --output-type dotenv` prints - the
 * file as it was written, values decrypted - into a flat env map, reading each line
 * the way compose reads an env file: quotes, an `export` prefix, a ` # comment`,
 * double-quote escapes and `${VAR}` references from earlier lines. (JSON output is
 * no use here: SOPS turns a literal `\n` into a newline when it reads the file, which
 * compose does only inside double quotes, and the JSON cannot tell the two apart.)
 *
 * Only `encryptedKeys` are returned: a value SOPS left in the clear is no secret
 * and compose reads it from the file. A line whose key is not a valid env-var name
 * is skipped, with its name reported, never its value.
 */
export function parseSopsDecryptOutput(
	stdout: string,
	encryptedKeys: ReadonlySet<string>
): { vars: Record<string, string>; skipped: string[] } {
	// Every value, encrypted or not, is known to the lines below it, as in compose.
	const known = Object.create(null) as Record<string, string>;
	const vars = Object.create(null) as Record<string, string>;
	const skipped: string[] = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const match = ENV_LINE_RE.exec(line);
		// __proto__ would set the prototype of the plain object the values are merged into.
		if (!match || match[1] === '__proto__' || match[2].includes('\0')) {
			skipped.push(trimmed.split('=', 1)[0].trim());
			continue;
		}
		const [, key, raw] = match;
		known[key] = expandValue(raw, known);
		if (encryptedKeys.has(key)) vars[key] = known[key];
	}
	return { vars, skipped };
}
