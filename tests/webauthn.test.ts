import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
	getWebAuthnConfig,
	hasExactWebAuthnOrigin,
	WebAuthnChallengeStore
} from '../src/lib/server/webauthn';

describe('WebAuthn challenge lifecycle', () => {
	it('binds registration to ceremony, user, and session and consumes exactly once', () => {
		const store = new WebAuthnChallengeStore(() => 1000, 300_000, 10);
		const entry = store.issue('challenge', 'registration', { userId: 7, sessionId: 'session-a' });

		assert.equal(store.consume(entry.id, 'registration', { userId: 7, sessionId: 'session-a' })?.challenge, 'challenge');
		assert.equal(store.consume(entry.id, 'registration', { userId: 7, sessionId: 'session-a' }), null);
	});

	it('burns a challenge after a wrong ceremony or binding', () => {
		const store = new WebAuthnChallengeStore(() => 1000);
		const wrongCeremony = store.issue('one', 'registration', { userId: 1, sessionId: 'a' });
		assert.equal(store.consume(wrongCeremony.id, 'authentication'), null);
		assert.equal(store.consume(wrongCeremony.id, 'registration', { userId: 1, sessionId: 'a' }), null);

		const wrongOwner = store.issue('two', 'registration', { userId: 1, sessionId: 'a' });
		assert.equal(store.consume(wrongOwner.id, 'registration', { userId: 2, sessionId: 'a' }), null);
		assert.equal(store.consume(wrongOwner.id, 'registration', { userId: 1, sessionId: 'a' }), null);
	});

	it('expires challenges and remains bounded', () => {
		let now = 1000;
		const store = new WebAuthnChallengeStore(() => now, 100, 2);
		const expired = store.issue('old', 'authentication');
		now = 1100;
		assert.equal(store.consume(expired.id, 'authentication'), null);

		store.issue('a', 'authentication');
		store.issue('b', 'authentication');
		assert.throws(() => store.issue('c', 'authentication'), /Too many pending/);
	});
});

describe('WebAuthn origin and RP configuration', () => {
	it('derives the RP ID only from canonical ORIGIN and enforces exact request origin', () => {
		const previousOrigin = process.env.ORIGIN;
		const previousNodeEnv = process.env.NODE_ENV;
		try {
			process.env.ORIGIN = 'https://dockhand.example.test:8443';
			process.env.NODE_ENV = 'production';
			assert.deepEqual(getWebAuthnConfig(), {
				expectedOrigin: 'https://dockhand.example.test:8443',
				rpId: 'dockhand.example.test'
			});
			assert.equal(hasExactWebAuthnOrigin(new Request('https://internal/', { headers: { Origin: 'https://dockhand.example.test:8443' } })), true);
			assert.equal(hasExactWebAuthnOrigin(new Request('https://internal/', { headers: { Origin: 'https://evil.example.test' } })), false);
		} finally {
			if (previousOrigin === undefined) delete process.env.ORIGIN;
			else process.env.ORIGIN = previousOrigin;
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
		}
	});

	it('allows HTTP only for local development and rejects unsafe or missing production origins', () => {
		const previousOrigin = process.env.ORIGIN;
		const previousNodeEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = 'production';
			process.env.ORIGIN = 'http://localhost:5173';
			assert.equal(getWebAuthnConfig().rpId, 'localhost');
			process.env.ORIGIN = 'http://dockhand.example.test';
			assert.throws(getWebAuthnConfig, /HTTPS ORIGIN/);
			delete process.env.ORIGIN;
			assert.throws(getWebAuthnConfig, /ORIGIN must be configured/);
		} finally {
			if (previousOrigin === undefined) delete process.env.ORIGIN;
			else process.env.ORIGIN = previousOrigin;
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
		}
	});
});

describe('Passkey migrations', () => {
	it('define equivalent unique, indexed, cascading credential storage for SQLite and PostgreSQL', () => {
		for (const path of ['drizzle/0012_add_passkey_credentials.sql', 'drizzle-pg/0012_add_passkey_credentials.sql']) {
			const sql = readFileSync(path, 'utf8');
			for (const column of ['user_id', 'credential_id', 'webauthn_user_id', 'public_key', 'counter', 'device_type', 'backed_up', 'transports', 'name', 'created_at']) {
				assert.match(sql, new RegExp(column));
			}
			assert.match(sql, /credential_id.*unique|unique.*credential_id/is);
			assert.match(sql, /user_id.*users.*delete cascade/is);
			assert.match(sql, /passkey_credentials_user_id_idx/);
		}
	});

	it('backfills existing names and enforces case-insensitive uniqueness per user', () => {
		for (const path of ['drizzle/0013_passkey_names.sql', 'drizzle-pg/0013_passkey_names.sql']) {
			const sql = readFileSync(path, 'utf8');
			assert.match(sql, /UPDATE.*passkey_credentials.*Passkey.*name/is);
			assert.match(sql, /passkey_credentials_user_name_unique/);
			assert.match(sql, /user_id.*lower\(["`]?name["`]?\)/is);
		}
	});
});
