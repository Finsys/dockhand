import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manualPullAgeWarning, parseMinimumReleaseAgeHours, releaseAgeRemainingMs, resolveMinimumReleaseAgeConfig, validImageCreatedAt, verifiedImagePullPlan } from '../src/lib/server/minimum-release-age-core';

describe('minimum release age', () => {
	test('accepts only bounded whole hours', () => {
		expect(parseMinimumReleaseAgeHours(72)).toBe(72);
		expect(parseMinimumReleaseAgeHours('0')).toBe(0);
		expect(parseMinimumReleaseAgeHours(721)).toBeNull();
		expect(parseMinimumReleaseAgeHours(-1)).toBeNull();
		expect(parseMinimumReleaseAgeHours(1.5)).toBeNull();
		expect(parseMinimumReleaseAgeHours('')).toBeNull();
	});

	test('uses environment override, then global setting, then default', () => {
		expect(resolveMinimumReleaseAgeConfig(undefined, 72, null)).toEqual({ hours: 72, overridden: false, inherited: true });
		expect(resolveMinimumReleaseAgeConfig(undefined, 72, 0)).toEqual({ hours: 0, overridden: false, inherited: false });
		expect(resolveMinimumReleaseAgeConfig(undefined, null, null)).toEqual({ hours: 0, overridden: false, inherited: true });
	});

	test('environment variable takes precedence over both settings', () => {
		expect(resolveMinimumReleaseAgeConfig('24', 72, 48)).toEqual({ hours: 24, overridden: true, inherited: true });
		expect(() => resolveMinimumReleaseAgeConfig('invalid', 72, 48)).toThrow();
	});

	test('holds a digest until the full configured time has elapsed', () => {
		const observed = '2026-09-28T00:00:00.000Z';
		const start = Date.parse(observed);
		expect(releaseAgeRemainingMs(observed, 72, start)).toBe(72 * 3600000);
		expect(releaseAgeRemainingMs(observed, 72, start + 72 * 3600000 - 1)).toBe(1);
		expect(releaseAgeRemainingMs(observed, 72, start + 72 * 3600000)).toBe(0);
	});

	test('invalid timestamps cannot make an image immediately eligible', () => {
		expect(releaseAgeRemainingMs('invalid', 24)).toBe(24 * 3600000);
	});

	test('manual pull warns during the cooldown or when observation fails', () => {
		const image = 'registry.example.com/team/app:latest';
		expect(manualPullAgeWarning(image, 0, null)).toBeNull();
		expect(manualPullAgeWarning(image, 1, null)).toContain('could not be determined');
		const observed = new Date(Date.now() - 15 * 60000).toISOString();
		const warning = manualPullAgeWarning(image, 1, { source: 'first-observed', observedAt: observed, remainingMs: 45 * 60000 });
		expect(warning).toContain(observed);
		expect(warning).toContain('15 minutes ago');
		expect(warning).toContain('45 minutes remain');
		expect(warning).toContain('Pulling it anyway');
		const createdWarning = manualPullAgeWarning(image, 1, { source: 'created', observedAt: observed, remainingMs: 45 * 60000 });
		expect(createdWarning).toContain('was created at');
		expect(createdWarning).not.toContain('first observed');
		expect(manualPullAgeWarning(image, 1, { source: 'first-observed', observedAt: observed, remainingMs: 0 })).toBeNull();
	});

	test('accepts only valid, non-future creation timestamps', () => {
		const now = Date.parse('2026-09-28T12:00:00Z');
		expect(validImageCreatedAt('2026-09-25T12:00:00Z', now)).toBe('2026-09-25T12:00:00.000Z');
		expect(validImageCreatedAt('2026-09-25T14:00:00+02:00', now)).toBe('2026-09-25T12:00:00.000Z');
		expect(validImageCreatedAt('2026-09-25T12:00:00.123456789Z', now)).toBe('2026-09-25T12:00:00.123Z');
		for (const value of [null, 0, '', 'invalid', '2026-09-25', '2026-02-30T00:00:00Z', '2026-09-25T24:00:00Z', '1970-01-01T00:00:00Z', '2026-09-29T00:00:00Z']) {
			expect(validImageCreatedAt(value, now)).toBeNull();
		}
	});

	test('pulls the verified digest and restores the requested local tag', () => {
		const digest = 'sha256:' + 'a'.repeat(64);
		expect(verifiedImagePullPlan('nginx:1.27', digest)).toEqual({
			reference: 'nginx@' + digest,
			tag: { repo: 'nginx', tag: '1.27' }
		});
		expect(verifiedImagePullPlan('registry.example.com:5000/team/app', digest)).toEqual({
			reference: 'registry.example.com:5000/team/app@' + digest,
			tag: { repo: 'registry.example.com:5000/team/app', tag: 'latest' }
		});
		expect(verifiedImagePullPlan('nginx@' + digest, digest)).toEqual({
			reference: 'nginx@' + digest,
			tag: null
		});
		expect(() => verifiedImagePullPlan('nginx@sha256:' + 'b'.repeat(64), digest)).toThrow('does not match');
		expect(() => verifiedImagePullPlan('nginx:latest', 'invalid')).toThrow('invalid image digest');
	});

});

// Run the service with a real SQLite store in a separate process: Bun module mocks
// are process-global and must not replace the DB used by unrelated test files.
const observationProbe = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
const root = ${JSON.stringify(fileURLToPath(new URL('../src/lib/server/', import.meta.url)))};
const { settings } = await import(root + 'db/schema/index.ts');
const sqlite = new Database(process.env.COOLDOWN_TEST_DB);
sqlite.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
const db = drizzle(sqlite);
mock.module(root + 'db/drizzle', () => ({ db, settings }));
mock.module(root + 'db', () => ({
 getSetting: async () => null, setSetting: async () => {},
 setEnvSetting: async () => {}, deleteSetting: async () => {}
}));
let providerRequests = 0;
globalThis.fetch = () => { providerRequests++; throw new Error('Unexpected provider API request'); };
const { imageReleaseAgeStatus, imageReleaseAgeRemainingMs } = await import(root + 'minimum-release-age.ts');
const digest = 'sha256:' + 'a'.repeat(64);
const hours = 72;
const maxMs = hours * 3600000;
const count = () => sqlite.query('SELECT count(*) AS n FROM settings').get().n;
if (process.env.COOLDOWN_TEST_PHASE === 'create') {
 assert.equal(await imageReleaseAgeRemainingMs('nginx:latest', digest, 0), 0);
 assert.equal(count(), 0, 'Disabled cooldown must not create observations');
 const observations = await Promise.all(Array.from({length: 20}, () => imageReleaseAgeStatus('nginx:latest', digest, hours)));
 assert.equal(count(), 1);
 assert.equal(new Set(observations.map(o => o.observedAt)).size, 1);
 assert.ok(observations.every(o => o.remainingMs > maxMs - 5000 && o.remainingMs <= maxMs));
 const alias = await imageReleaseAgeStatus('docker.io/library/nginx:stable', digest, hours);
 assert.equal(alias.observedAt, observations[0].observedAt, 'Tags and Hub aliases share a digest observation');
 assert.equal(count(), 1);
 // Simulate an aged persisted observation, then reopen the database in another process.
 sqlite.query('UPDATE settings SET value = ?').run(JSON.stringify('2020-01-01T00:00:00.000Z'));
} else {
 const existing = await imageReleaseAgeStatus('nginx:latest', digest, hours);
 assert.equal(existing.observedAt, '2020-01-01T00:00:00.000Z');
 assert.equal(existing.remainingMs, 0, 'A restart or re-check must not reset the cooldown');
 const changed = await imageReleaseAgeStatus('nginx:latest', 'sha256:' + 'b'.repeat(64), hours);
 assert.ok(changed.remainingMs > maxMs - 5000, 'A changed digest starts its own cooldown');
 for (const image of ['ghcr.io/team/app:latest', 'gitea.example.com/team/app:latest', 'registry.example.com/team/app:latest']) {
  const status = await imageReleaseAgeStatus(image, digest, hours);
  assert.ok(status.remainingMs > maxMs - 5000, 'Every provider starts a full first-observed cooldown');
 }
 await imageReleaseAgeStatus('registry.example.com/team/other:latest', digest, hours);
 assert.equal(count(), 6, 'Observations are scoped to registry, repository and digest');
 const oldCreation = new Date(Date.now() - 3 * 86400000).toISOString();
 const old = await imageReleaseAgeStatus('registry.example.com/team/old:latest', digest, 24, async () => oldCreation);
 assert.equal(old.source, 'created');
 assert.equal(old.remainingMs, 0, 'A three-day-old image must immediately pass a one-day minimum');
 const recentCreation = new Date(Date.now() - 3600000).toISOString();
 const recent = await imageReleaseAgeStatus('registry.example.com/team/old:latest', digest, 24, async () => recentCreation);
 assert.equal(recent.source, 'created');
 assert.ok(recent.remainingMs > 22 * 3600000 && recent.remainingMs <= 23 * 3600000);
 const fallback = await imageReleaseAgeStatus('registry.example.com/team/old:latest', digest, 24);
 assert.equal(fallback.source, 'first-observed');
 assert.ok(fallback.remainingMs > 24 * 3600000 - 5000);
 for (const timestamp of [null, 'garbage', new Date(Date.now() + 86400000).toISOString()]) {
  const invalid = await imageReleaseAgeStatus('registry.example.com/team/old:latest', digest, 24, async () => timestamp);
  assert.equal(invalid.source, 'first-observed');
  assert.equal(invalid.observedAt, fallback.observedAt, 'Invalid metadata must retain original observation');
 }
 const unavailable = await imageReleaseAgeStatus('registry.example.com/team/old:latest', digest, 24, async () => { throw new Error('unreachable'); });
 assert.equal(unavailable.observedAt, fallback.observedAt);
 let lookedUp = false;
 assert.equal(await imageReleaseAgeRemainingMs('nginx:latest', digest, 0, async () => { lookedUp = true; return oldCreation; }), 0);
 assert.equal(lookedUp, false, 'Disabled cooldown must not query metadata');
}
assert.equal(providerRequests, 0, 'Cooldown must not query provider APIs');
sqlite.close();
await assert.rejects(imageReleaseAgeRemainingMs('nginx:latest', digest, hours), 'Storage failures must not approve an automatic update');
`;

test('persists one digest observation across concurrent checks and process restarts', () => {
	const directory = mkdtempSync(join(tmpdir(), 'dockhand-cooldown-test-'));
	try {
		for (const phase of ['create', 'reopen']) {
			const result = spawnSync(process.execPath, ['--eval', observationProbe], {
				cwd: fileURLToPath(new URL('..', import.meta.url)),
				env: { ...process.env, COOLDOWN_TEST_DB: join(directory, 'observations.sqlite'), COOLDOWN_TEST_PHASE: phase },
				encoding: 'utf8',
				timeout: 10000
			});
			expect({ phase, status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({
				phase, status: 0, error: undefined, stderr: ''
			});
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
