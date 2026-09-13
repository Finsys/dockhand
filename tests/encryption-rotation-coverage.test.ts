/**
 * Regression guard for audit 2026-06-26 #6: backup_destinations were excluded
 * from ENCRYPTION_KEY rotation/migration in encryption.ts::migrateCredentials.
 * After an app-key rotation every OTHER credential table was re-encrypted with
 * the new key while backup destination password/envVars stayed on the OLD key,
 * so restic got the literal `enc:v1:...` blob as its password and every backup
 * broke silently.
 *
 * migrateCredentials talks to better-sqlite3, which bun test can't load, so we
 * can't drive the rotation end-to-end here. Instead we assert — at the source
 * level — that the migrator actually references the backupDestinations table in
 * BOTH the rotation branch and the plain-text migration branch. This is the
 * exact thing the bug got wrong: a hardcoded table list that silently omitted
 * one table. If someone drops the coverage again, this fails.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const encryptionSrc = readFileSync(
	join(here, '..', 'src', 'lib', 'server', 'encryption.ts'),
	'utf8'
);

describe('encryption key rotation covers backup destinations (audit #6)', () => {
	it('imports the backupDestinations table into migrateCredentials', () => {
		assert.match(
			encryptionSrc,
			/backupDestinations/,
			'migrateCredentials must import/use backupDestinations or key rotation silently breaks backups'
		);
	});

	it('re-encrypts backup destination password and envVars during rotation', () => {
		// The rotation branch collects encrypted values into allEncrypted; both
		// fields must be pushed so the new key re-encrypts them.
		assert.match(encryptionSrc, /table:\s*'backupDestinations',\s*id:\s*dest\.id,\s*field:\s*'password'/);
		assert.match(encryptionSrc, /table:\s*'backupDestinations',\s*id:\s*dest\.id,\s*field:\s*'envVars'/);
	});

	it('writes the re-encrypted backup destination values back on rotation', () => {
		// HIGH #7 (2026-07-02) moved the rotation writes into ONE transaction, so
		// the write goes through the tx handle rather than db directly.
		assert.match(
			encryptionSrc,
			/item\.table === 'backupDestinations'[\s\S]{0,200}(db|tx)\.update\(backupDestinations\)/,
			'rotation must (db|tx).update(backupDestinations) with the re-encrypted value'
		);
	});

	it('migrates legacy plain-text backup destination secrets to encrypted form', () => {
		// The plain-text branch must also touch backupDestinations, not just the
		// other credential tables.
		assert.match(
			encryptionSrc,
			/dest\.password[\s\S]{0,120}encrypt\(dest\.password\)/,
			'plain-text migration must encrypt an unencrypted backup destination password'
		);
	});
});

// Same bug class for the secret_providers table: its `config` column holds the
// encrypted Vault/Doppler/1Password token. If rotation omits it, the provider
// config stays on the OLD key and becomes permanently undecryptable once the key
// file is deleted, so every provider-bound stack fails to deploy.
describe('encryption key rotation covers secret providers', () => {
	it('imports the secretProviders table into migrateCredentials', () => {
		assert.match(
			encryptionSrc,
			/secretProviders/,
			'migrateCredentials must import/use secretProviders or key rotation breaks provider-bound stacks'
		);
	});

	it('collects the secret provider config for re-encryption during rotation', () => {
		assert.match(encryptionSrc, /table:\s*'secretProviders',\s*id:\s*p\.id,\s*field:\s*'config'/);
	});

	it('writes the re-encrypted secret provider config back on rotation', () => {
		assert.match(
			encryptionSrc,
			/item\.table === 'secretProviders'[\s\S]{0,200}(db|tx)\.update\(secretProviders\)/,
			'rotation must (db|tx).update(secretProviders) with the re-encrypted config'
		);
	});
});

// The rollback envelope is the reason a mid-rotation crash can't strand
// credentials as an undecryptable old/new-key mix. A true execution test isn't
// possible here (migrateCredentials imports better-sqlite3, which bun test can't
// load, and the HTTP API can't force a mid-transaction failure), so we assert the
// safety contract at the source level: it must survive any future refactor.
describe('encryption key rotation rolls back atomically on failure', () => {
	it('re-encrypts every credential inside a single db.transaction', () => {
		assert.match(
			encryptionSrc,
			/db\.transaction\(async \(tx[\s\S]*?for \(const item of allEncrypted\)/,
			'the re-encrypt loop must run inside db.transaction so a mid-loop failure rolls back'
		);
	});

	it('captures the old key and restores it when the transaction throws', () => {
		assert.match(encryptionSrc, /const oldKey = cachedKey;/, 'must capture the old key before switching');
		// The catch block must put the in-memory key back to match the rolled-back DB.
		assert.match(
			encryptionSrc,
			/catch \([\s\S]*?cachedKey = oldKey;[\s\S]*?throw /,
			'on failure the catch must restore cachedKey = oldKey AND rethrow so nothing becomes unrecoverable'
		);
	});
});
