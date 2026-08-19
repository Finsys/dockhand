import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import postgres from 'postgres';

const databaseUrl = process.env.PASSKEY_TEST_POSTGRES_URL;

describe('PostgreSQL Passkey persistence', () => {
	it('enforces credential and per-user name uniqueness and cascades credentials', { skip: !databaseUrl }, async () => {
		const sql = postgres(databaseUrl!, { max: 1 });
		try {
			await sql.unsafe('DROP TABLE IF EXISTS passkey_credentials');
			await sql.unsafe('DROP TABLE IF EXISTS users');
			await sql.unsafe('CREATE TABLE users (id serial PRIMARY KEY)');

			const migration = readFileSync('drizzle-pg/0012_add_passkey_credentials.sql', 'utf8');
			for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
				await sql.unsafe(statement);
			}
			const nameMigration = readFileSync('drizzle-pg/0013_passkey_names.sql', 'utf8');
			for (const statement of nameMigration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
				await sql.unsafe(statement);
			}

			const [firstUser, secondUser] = await sql`INSERT INTO users DEFAULT VALUES RETURNING id`.then(async ([first]) => {
				const [second] = await sql`INSERT INTO users DEFAULT VALUES RETURNING id`;
				return [first, second];
			});
			await sql`
				INSERT INTO passkey_credentials
					(user_id, credential_id, webauthn_user_id, public_key, counter, device_type, backed_up, transports, name)
				VALUES
					(${firstUser.id}, 'credential-one', 'user-handle', 'public-key', 0, 'multiDevice', true, '["internal"]', 'Laptop')
			`;

			await assert.rejects(
				sql`
					INSERT INTO passkey_credentials
						(user_id, credential_id, webauthn_user_id, public_key, counter, device_type, backed_up)
					VALUES
						(${secondUser.id}, 'credential-one', 'other-handle', 'other-key', 0, 'singleDevice', false)
				`,
				(error: { code?: string }) => error.code === '23505'
			);

			await assert.rejects(
				sql`
					INSERT INTO passkey_credentials
						(user_id, credential_id, webauthn_user_id, public_key, counter, device_type, backed_up, name)
					VALUES
						(${firstUser.id}, 'credential-two', 'user-handle', 'other-key', 0, 'singleDevice', false, 'lApToP')
				`,
				(error: { code?: string }) => error.code === '23505'
			);

			await sql`
				INSERT INTO passkey_credentials
					(user_id, credential_id, webauthn_user_id, public_key, counter, device_type, backed_up, name)
				VALUES
					(${secondUser.id}, 'credential-three', 'other-handle', 'other-key', 0, 'singleDevice', false, 'LAPTOP')
			`;

			await sql`DELETE FROM users WHERE id = ${firstUser.id}`;
			const [{ count }] = await sql`SELECT count(*)::int AS count FROM passkey_credentials WHERE user_id = ${firstUser.id}`;
			assert.equal(count, 0);
		} finally {
			await sql.end();
		}
	});
});
