/**
 * Credential Encryption Module
 *
 * Provides AES-256-GCM encryption for sensitive credentials at rest.
 * 1. No file, no env var: Generate key, save to file (initial setup)
 * 2. File exists, no env var: Use file key (unchanged)
 * 3. No file, env var set: Use env var key, do NOT save to file
 * 4. File exists, env var set (same key): Use key, delete file (env var is source of truth)
 * 5. File exists, env var set (different key): Re-encrypt with env var key, delete file
 *
 * Once a user provides ENCRYPTION_KEY, the key file is removed - the key lives only in memory
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Encryption algorithm: AES-256 with GCM mode (authenticated encryption) */
const ALGORITHM = 'aes-256-gcm';

/** Initialization vector length in bytes */
const IV_LENGTH = 12;

/** Authentication tag length in bytes */
const AUTH_TAG_LENGTH = 16;

/** Encryption key length in bytes (256 bits) */
const KEY_LENGTH = 32;

/** Prefix for encrypted values (version 1) */
const ENCRYPTED_PREFIX = 'enc:v1:';

/** File name for auto-generated encryption key */
const KEY_FILE_NAME = '.encryption_key';

let cachedKey: Buffer | null = null;

/** Pending key rotation state (set when env var differs from file) */
let pendingKeyRotation: { oldKey: Buffer; newKey: Buffer } | null = null;

function getDataDir(): string {
	return process.env.DATA_DIR || './data';
}

/**
 * Get or create the encryption key.
 *
 * Hybrid key management approach:
 * 1. No file, no env var: Generate key, save to file (initial setup)
 * 2. File exists, no env var: Use file key (unchanged)
 * 3. No file, env var set: Use env var key, do NOT save to file
 * 4. File exists, env var set (same key): Use key, delete file (env var is source of truth)
 * 5. File exists, env var set (different key): Re-encrypt with env var key, delete file after migration
 *
 * Once user provides ENCRYPTION_KEY, the key file is removed - the key lives
 * only in memory from the environment variable.
 */
function getOrCreateKey(): Buffer {
	// Return cached key if available
	if (cachedKey) {
		return cachedKey;
	}

	const dataDir = getDataDir();
	const keyPath = join(dataDir, KEY_FILE_NAME);
	const envKey = process.env.ENCRYPTION_KEY;

	// 1. File exists?
	if (existsSync(keyPath)) {
		try {
			const fileKey = readFileSync(keyPath);
			if (fileKey.length !== KEY_LENGTH) {
				throw new Error(`Key file has invalid length: expected ${KEY_LENGTH}, got ${fileKey.length}`);
			}

			// Env var also set? Env var takes over, file will be deleted
			if (envKey) {
				try {
					const envKeyBuffer = Buffer.from(envKey, 'base64');
					if (envKeyBuffer.length !== KEY_LENGTH) {
						console.warn('[Encryption] WARNING: ENCRYPTION_KEY env var has invalid length (ignored)');
						// Fall through to use file key
					} else if (!fileKey.equals(envKeyBuffer)) {
						// Different key - trigger key rotation mode
						// File will be deleted after re-encryption in migrateCredentials()
						console.log('[Encryption] Key change detected - will re-encrypt and remove key file');
						pendingKeyRotation = { oldKey: fileKey, newKey: envKeyBuffer };
						// Return OLD key for decryption first
						cachedKey = fileKey;
						return cachedKey;
					} else {
						// Same key - delete file immediately, env var is now source of truth
						try {
							unlinkSync(keyPath);
							console.log('[Encryption] Using ENCRYPTION_KEY from environment, removed key file');
						} catch (unlinkError) {
							const msg = unlinkError instanceof Error ? unlinkError.message : String(unlinkError);
							console.warn(`[Encryption] Could not remove key file: ${msg}`);
						}
						cachedKey = envKeyBuffer;
						return cachedKey;
					}
				} catch {
					console.warn('[Encryption] WARNING: ENCRYPTION_KEY env var is invalid (ignored)');
				}
			}

			// No env var or invalid env var - use file key
			cachedKey = fileKey;
			console.log('[Encryption] Using encryption key from', keyPath);
			return cachedKey;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to read encryption key from ${keyPath}: ${msg}`);
		}
	}

	// 2. No file - env var set? Use it WITHOUT saving to file
	if (envKey) {
		try {
			const keyBuffer = Buffer.from(envKey, 'base64');
			if (keyBuffer.length !== KEY_LENGTH) {
				throw new Error(`ENCRYPTION_KEY must be exactly ${KEY_LENGTH} bytes when decoded`);
			}
			cachedKey = keyBuffer;
			console.log('[Encryption] Using ENCRYPTION_KEY from environment (not persisted to disk)');
			return cachedKey;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid ENCRYPTION_KEY: ${msg}`);
		}
	}

	// 3. No file, no env var - generate new key and save to file (initial setup)
	// Ensure data directory exists before writing
	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, { recursive: true });
	}

	console.log('[Encryption] Generating new encryption key...');
	cachedKey = randomBytes(KEY_LENGTH);

	// Save key with restricted permissions (0600 = owner read/write only)
	try {
		writeFileSync(keyPath, cachedKey, { mode: 0o600 });
		console.log('[Encryption] Saved new encryption key to', keyPath);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[Encryption] Warning: Failed to save encryption key to ${keyPath}: ${msg}`);
		console.error('[Encryption] Encryption will work for this session but keys will be regenerated on restart');
	}

	return cachedKey;
}

// =============================================================================
// ENCRYPTION / DECRYPTION
// =============================================================================

/**
 * Encrypt a plain text value using AES-256-GCM.
 *
 * @param plaintext - The value to encrypt (or null/empty)
 * @returns Encrypted value with "enc:v1:" prefix, or null/empty if input was null/empty
 *
 * Format: enc:v1:<base64(iv + authTag + ciphertext)>
 */
export function encrypt(plaintext: string | null | undefined): string | null {
	// Pass through null/undefined/empty values
	if (plaintext === null || plaintext === undefined || plaintext === '') {
		return plaintext as string | null;
	}

	// Don't double-encrypt
	if (plaintext.startsWith(ENCRYPTED_PREFIX)) {
		return plaintext;
	}

	const key = getOrCreateKey();
	const iv = randomBytes(IV_LENGTH);

	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, 'utf8'),
		cipher.final()
	]);

	const authTag = cipher.getAuthTag();

	// Combine: iv (12 bytes) + authTag (16 bytes) + ciphertext
	const combined = Buffer.concat([iv, authTag, ciphertext]);

	return ENCRYPTED_PREFIX + combined.toString('base64');
}

/**
 * Decrypt a value that may be encrypted or plain text.
 *
 * If the value doesn't have the "enc:v1:" prefix, it's assumed to be plain text and returned as-is. 
 *
 * @param value - The value to decrypt (encrypted with prefix, plain text, null, or empty)
 * @returns Decrypted value, or the original value if not encrypted, or null if input was null
 */
export function decrypt(value: string | null | undefined): string | null {
	// Pass through null/undefined/empty values
	if (value === null || value === undefined || value === '') {
		return value as string | null;
	}

	// BACKWARDS COMPATIBILITY: If no prefix, it's plain text - return as-is
	if (!value.startsWith(ENCRYPTED_PREFIX)) {
		return value;
	}

	// Extract the base64 payload after the prefix
	const payload = value.substring(ENCRYPTED_PREFIX.length);

	let combined: Buffer;
	try {
		combined = Buffer.from(payload, 'base64');
	} catch {
		console.error('[Encryption] Failed to decode base64 payload');
		// Return original value to avoid data loss
		return value;
	}

	// Validate minimum length: iv (12) + authTag (16) + at least 1 byte ciphertext
	if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
		console.error('[Encryption] Encrypted payload is too short');
		return value;
	}

	// Extract components
	const iv = combined.subarray(0, IV_LENGTH);
	const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

	try {
		const key = getOrCreateKey();
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final()
		]);

		return decrypted.toString('utf8');
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[Encryption] Decryption failed: ${msg}`);
		// Return original value to avoid data loss (might be corrupted or wrong key)
		return value;
	}
}

/**
 * Check if a value is encrypted (has the encryption prefix).
 *
 * @param value - The value to check
 * @returns true if the value appears to be encrypted
 */
export function isEncrypted(value: string | null | undefined): boolean {
	return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Generate a new encryption key and return it as base64.
 * Useful for generating ENCRYPTION_KEY environment variable values.
 *
 * @returns Base64-encoded 32-byte encryption key
 */
export function generateKey(): string {
	return randomBytes(KEY_LENGTH).toString('base64');
}

/**
 * Clear the cached encryption key.
 * Primarily for testing purposes.
 */
export function clearKeyCache(): void {
	cachedKey = null;
	pendingKeyRotation = null;
}

/**
 * Initialize encryption and migrate unencrypted credentials.
 *
 * 1. Ensures encryption key exists (generates or loads from file/env var)
 * 2. Checks for pending key rotation (re-encrypts with new key, removes key file)
 * 3. Encrypts any values that don't have the "enc:v1:" prefix
 *
 * This is idempotent - safe to call on every startup.
 */
export async function migrateCredentials(): Promise<void> {
	// IMPORTANT: Always initialize the key on startup, even if there are no credentials yet.
	// This ensures the key file is created before any credentials are added.
	getOrCreateKey();

	console.log('[Encryption] Checking for unencrypted credentials...');

	// Import database dynamically to avoid circular dependency
	const {
		db,
		eq,
		registries,
		gitCredentials,
		environments,
		oidcConfig,
		ldapConfig,
		notificationSettings,
		stackEnvironmentVariables
	} = await import('./db/drizzle.js');

	let migrated = 0;
	const keyPath = join(getDataDir(), KEY_FILE_NAME);

	// Check for key rotation first
	if (pendingKeyRotation) {
		console.log('[Encryption] Performing key rotation - re-encrypting all credentials...');

		// Decrypt everything with old key, then switch to new key
		// The old key is already cached, so decrypt will use it

		// 1. Collect all encrypted values (we need to decrypt then re-encrypt)
		const allEncrypted: Array<{
			table: string;
			id: number;
			field: string;
			value: string;
		}> = [];

		const regs = await db.select().from(registries);
		for (const reg of regs) {
			if (reg.password && isEncrypted(reg.password)) {
				allEncrypted.push({ table: 'registries', id: reg.id, field: 'password', value: reg.password });
			}
		}

		const gitCreds = await db.select().from(gitCredentials);
		for (const cred of gitCreds) {
			if (cred.password && isEncrypted(cred.password)) {
				allEncrypted.push({ table: 'gitCredentials', id: cred.id, field: 'password', value: cred.password });
			}
			if (cred.sshPrivateKey && isEncrypted(cred.sshPrivateKey)) {
				allEncrypted.push({ table: 'gitCredentials', id: cred.id, field: 'sshPrivateKey', value: cred.sshPrivateKey });
			}
			if (cred.sshPassphrase && isEncrypted(cred.sshPassphrase)) {
				allEncrypted.push({ table: 'gitCredentials', id: cred.id, field: 'sshPassphrase', value: cred.sshPassphrase });
			}
		}

		const envs = await db.select().from(environments);
		for (const env of envs) {
			if (env.hawserToken && isEncrypted(env.hawserToken)) {
				allEncrypted.push({ table: 'environments', id: env.id, field: 'hawserToken', value: env.hawserToken });
			}
			if (env.tlsKey && isEncrypted(env.tlsKey)) {
				allEncrypted.push({ table: 'environments', id: env.id, field: 'tlsKey', value: env.tlsKey });
			}
		}

		const oidcConfigs = await db.select().from(oidcConfig);
		for (const config of oidcConfigs) {
			if (config.clientSecret && isEncrypted(config.clientSecret)) {
				allEncrypted.push({ table: 'oidcConfig', id: config.id, field: 'clientSecret', value: config.clientSecret });
			}
		}

		const ldapConfigs = await db.select().from(ldapConfig);
		for (const config of ldapConfigs) {
			if (config.bindPassword && isEncrypted(config.bindPassword)) {
				allEncrypted.push({ table: 'ldapConfig', id: config.id, field: 'bindPassword', value: config.bindPassword });
			}
		}

		const notifSettings = await db.select().from(notificationSettings);
		for (const notif of notifSettings) {
			if (notif.config) {
				try {
					const config = JSON.parse(notif.config);
					if (config.smtpPassword && isEncrypted(config.smtpPassword)) {
						allEncrypted.push({ table: 'notificationSettings', id: notif.id, field: 'config.smtpPassword', value: config.smtpPassword });
					}
				} catch {
					// Invalid JSON, skip
				}
			}
		}

		const stackEnvVars = await db.select().from(stackEnvironmentVariables);
		for (const envVar of stackEnvVars) {
			if (envVar.isSecret && envVar.value && isEncrypted(envVar.value)) {
				allEncrypted.push({ table: 'stackEnvironmentVariables', id: envVar.id, field: 'value', value: envVar.value });
			}
		}

		// Decrypt all values with old key
		const decryptedValues: Map<string, string> = new Map();
		for (const item of allEncrypted) {
			const decrypted = decrypt(item.value);
			if (decrypted) {
				decryptedValues.set(`${item.table}:${item.id}:${item.field}`, decrypted);
			}
		}

		// Switch to new key
		cachedKey = pendingKeyRotation.newKey;

		// Re-encrypt and update all values
		for (const item of allEncrypted) {
			const decrypted = decryptedValues.get(`${item.table}:${item.id}:${item.field}`);
			if (decrypted) {
				const reEncrypted = encrypt(decrypted);

				// Update database based on table
				if (item.table === 'registries') {
					await db.update(registries).set({ [item.field]: reEncrypted }).where(eq(registries.id, item.id));
				} else if (item.table === 'gitCredentials') {
					await db.update(gitCredentials).set({ [item.field]: reEncrypted }).where(eq(gitCredentials.id, item.id));
				} else if (item.table === 'environments') {
					await db.update(environments).set({ [item.field]: reEncrypted }).where(eq(environments.id, item.id));
				} else if (item.table === 'oidcConfig') {
					await db.update(oidcConfig).set({ [item.field]: reEncrypted }).where(eq(oidcConfig.id, item.id));
				} else if (item.table === 'ldapConfig') {
					await db.update(ldapConfig).set({ [item.field]: reEncrypted }).where(eq(ldapConfig.id, item.id));
				} else if (item.table === 'notificationSettings' && item.field === 'config.smtpPassword') {
					// Need to update the JSON field
					const notif = notifSettings.find(n => n.id === item.id);
					if (notif) {
						const config = JSON.parse(notif.config);
						config.smtpPassword = reEncrypted;
						await db.update(notificationSettings).set({ config: JSON.stringify(config) }).where(eq(notificationSettings.id, item.id));
					}
				} else if (item.table === 'stackEnvironmentVariables') {
					await db.update(stackEnvironmentVariables).set({ value: reEncrypted }).where(eq(stackEnvironmentVariables.id, item.id));
				}

				migrated++;
			}
		}

		// Delete key file - env var is now the source of truth
		if (existsSync(keyPath)) {
			try {
				unlinkSync(keyPath);
				console.log('[Encryption] Deleted key file - now using ENCRYPTION_KEY from environment only');
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.warn(`[Encryption] Could not delete key file: ${msg}`);
			}
		}

		pendingKeyRotation = null;

		if (migrated > 0) {
			console.log(`[Encryption] Re-encrypted ${migrated} credentials with new key`);
		} else {
			console.log('[Encryption] Key rotation complete (no credentials to re-encrypt)');
		}
		return;
	}

	const regs = await db.select().from(registries);
	for (const reg of regs) {
		if (reg.password && !isEncrypted(reg.password)) {
			await db.update(registries)
				.set({ password: encrypt(reg.password) })
				.where(eq(registries.id, reg.id));
			migrated++;
		}
	}

	const gitCreds = await db.select().from(gitCredentials);
	for (const cred of gitCreds) {
		const updates: Record<string, string | null> = {};
		if (cred.password && !isEncrypted(cred.password)) {
			updates.password = encrypt(cred.password);
			migrated++;
		}
		if (cred.sshPrivateKey && !isEncrypted(cred.sshPrivateKey)) {
			updates.sshPrivateKey = encrypt(cred.sshPrivateKey);
			migrated++;
		}
		if (cred.sshPassphrase && !isEncrypted(cred.sshPassphrase)) {
			updates.sshPassphrase = encrypt(cred.sshPassphrase);
			migrated++;
		}
		if (Object.keys(updates).length > 0) {
			await db.update(gitCredentials).set(updates).where(eq(gitCredentials.id, cred.id));
		}
	}

	const envs = await db.select().from(environments);
	for (const env of envs) {
		const updates: Record<string, string | null> = {};
		if (env.hawserToken && !isEncrypted(env.hawserToken)) {
			updates.hawserToken = encrypt(env.hawserToken);
			migrated++;
		}
		if (env.tlsKey && !isEncrypted(env.tlsKey)) {
			updates.tlsKey = encrypt(env.tlsKey);
			migrated++;
		}
		if (Object.keys(updates).length > 0) {
			await db.update(environments).set(updates).where(eq(environments.id, env.id));
		}
	}

	const oidcConfigs = await db.select().from(oidcConfig);
	for (const config of oidcConfigs) {
		if (config.clientSecret && !isEncrypted(config.clientSecret)) {
			await db.update(oidcConfig)
				.set({ clientSecret: encrypt(config.clientSecret) })
				.where(eq(oidcConfig.id, config.id));
			migrated++;
		}
	}

	const ldapConfigs = await db.select().from(ldapConfig);
	for (const config of ldapConfigs) {
		if (config.bindPassword && !isEncrypted(config.bindPassword)) {
			await db.update(ldapConfig)
				.set({ bindPassword: encrypt(config.bindPassword) })
				.where(eq(ldapConfig.id, config.id));
			migrated++;
		}
	}

	const notifSettings = await db.select().from(notificationSettings);
	for (const notif of notifSettings) {
		if (notif.config) {
			try {
				const config = JSON.parse(notif.config);
				if (config.smtpPassword && !isEncrypted(config.smtpPassword)) {
					config.smtpPassword = encrypt(config.smtpPassword);
					await db.update(notificationSettings)
						.set({ config: JSON.stringify(config) })
						.where(eq(notificationSettings.id, notif.id));
					migrated++;
				}
			} catch {
				// Invalid JSON, skip
			}
		}
	}

	const stackEnvVars = await db.select().from(stackEnvironmentVariables);
	for (const envVar of stackEnvVars) {
		if (envVar.isSecret && envVar.value && !isEncrypted(envVar.value)) {
			await db.update(stackEnvironmentVariables)
				.set({ value: encrypt(envVar.value) })
				.where(eq(stackEnvironmentVariables.id, envVar.id));
			migrated++;
		}
	}

	if (migrated > 0) {
		console.log(`[Encryption] Migrated ${migrated} credentials to encrypted storage`);
	}
}
