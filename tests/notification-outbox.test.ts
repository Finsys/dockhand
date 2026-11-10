import { describe, test, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/bun-sqlite';
import { drizzle as postgresDrizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { notificationDeliveries as sqliteTable } from '../src/lib/server/db/schema';
import { notificationDeliveries as pgTable } from '../src/lib/server/db/schema/pg-schema';
import { createNotificationOutboxStore } from '../src/lib/server/notifications/outbox-store';
import { createNotificationOutboxWorker } from '../src/lib/server/notifications/outbox-worker';
import { createQueuedWebhook, notificationEventSnapshot, resolveWebhookDestination } from '../src/lib/server/notifications/outbox-model';
import { notificationRetryPolicy, notificationDeliveryView, retryAfterMilliseconds, webhookRetryDelay,
	type NotificationDelivery, type WebhookAttemptResult } from '../src/lib/utils/notification-retries';
import { requireNotificationDeliveryAccess } from '../src/lib/server/notifications/outbox-authorization';

const base = Date.parse('2026-11-10T12:00:00Z');
const policy = notificationRetryPolicy({ enabled: true });
const event = notificationEventSnapshot({ title: 'Container Start', message: 'Container "fixture" started', eventType: 'container_started', environmentId: 1, environmentName: 'Test', timestamp: new Date(base).toISOString() });
const make = (channel = 1, now = base) => createQueuedWebhook(channel, `jsons://receiver.example.org/${channel}`, event, policy, 'environment', now);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(engine: string, durable = false) {
	const dir = mkdtempSync(join(tmpdir(), 'dockhand-outbox-'));
	const namespace = 'outbox_' + randomUUID().replaceAll('-', '');
	let connection: any, store: ReturnType<typeof createNotificationOutboxStore>;
	const open = () => {
		if (engine === 'sqlite') {
			connection = new Database(durable ? join(dir, 'outbox.db') : ':memory:');
			connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
			store = createNotificationOutboxStore(sqliteDrizzle(connection), sqliteTable);
		} else {
			connection = postgres(process.env.DOCKHAND_OUTBOX_TEST_POSTGRES_URL!, { max: 4, connection: { search_path: namespace } });
			store = createNotificationOutboxStore(postgresDrizzle(connection), pgTable);
		}
	};
	const close = async () => {
		if (engine === 'sqlite') { connection.clearQueryCache(); Bun.gc(true); connection.close(); }
		else await connection.end({ timeout: 5 });
	};
	open();
	const run = (statement: string) => engine === 'sqlite' ? connection.exec(statement) : connection.unsafe(statement);
	if (engine !== 'sqlite') await run(`CREATE SCHEMA "${namespace}"`);
	await run('CREATE TABLE notification_settings (id integer PRIMARY KEY); CREATE TABLE environments (id integer PRIMARY KEY); INSERT INTO notification_settings VALUES (1), (2); INSERT INTO environments VALUES (1), (2);');
	const migration = readFileSync(new URL(`../${engine === 'sqlite' ? 'drizzle' : 'drizzle-pg'}/0023_notification_deliveries.sql`, import.meta.url), 'utf8');
	await run(migration);
	cleanups.push(async () => {
		if (engine !== 'sqlite') await run(`DROP SCHEMA "${namespace}" CASCADE`);
		await close();
		if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test fixture cleanup');
		// Bun on Windows releases SQLite statement handles during GC; give finalizers
		// an event-loop turn before deleting this fixture's verified temporary directory.
		for (let attempt = 0; ; attempt++) {
			Bun.gc(true);
			try { rmSync(dir, { recursive: true, force: true }); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt >= 10) throw error;
				await Bun.sleep(20);
			}
		}
	});
	return { get store() { return store; }, run, async reopen() { await close(); open(); } };
}

for (const engine of ['sqlite', ...(process.env.DOCKHAND_OUTBOX_TEST_POSTGRES_URL ? ['postgres'] : [])]) describe(`persistent notification outbox (${engine})`, () => {
	test('commits before sending and retries only the failed destination after reopening', async () => {
		const app = await fixture(engine, true), rows = [make(1), make(2)], calls: Array<{ id: string; body: string; eventId: string }> = [];
		for (const row of rows) await app.store.enqueue(row);
		expect((await app.store.get(rows[0].id))?.status).toBe('pending');
		let now = base, recovered = false;
		const worker = () => createNotificationOutboxWorker({ store: app.store, now: () => now, random: () => .5,
			resolve: async row => `https://receiver.example.org/${row.notificationId}`, send: async (_url, row) => {
				calls.push({ id: row.id, body: row.body, eventId: row.eventId });
				return { success: row.notificationId === 2 || recovered, status: row.notificationId === 2 || recovered ? 202 : 503 };
			} });
		await worker().drain();
		expect(calls).toHaveLength(2);
		expect((await app.store.get(rows[0].id))?.dueAt).toBe(base + 5000);
		expect((await app.store.get(rows[1].id))?.status).toBe('succeeded');
		await app.reopen(); recovered = true; now += 4999;
		await worker().drain(); expect(calls).toHaveLength(2);
		now++; await worker().drain(); expect(calls).toHaveLength(3);
		expect(calls.filter(call => call.id === rows[1].id)).toHaveLength(1);
		expect(calls.filter(call => call.id === rows[0].id).map(call => call.body)).toEqual([rows[0].body, rows[0].body]);
		expect(new Set(calls.map(call => call.eventId)).size).toBe(1);
		expect((await app.store.get(rows[0].id))?.attempts).toBe(2);
		await worker().drain(); expect(calls).toHaveLength(3);
	});

	test('replays a genuinely unaccepted local HTTP request after receiver recovery', async () => {
		const app = await fixture(engine, true), row = make(); await app.store.enqueue(row);
		let now = base, available = false, received: string[] = [];
		const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
			if (!available) return new Response('Unavailable', { status: 503 });
			received.push(await request.text()); return new Response('', { status: 202 });
		} });
		try {
			const worker = () => createNotificationOutboxWorker({ store: app.store, now: () => now, random: () => .5,
				resolve: async () => String(server.url), send: (url, current, signal) => new Promise((resolve, reject) => {
					// Other provider suites replace global fetch; keep this real-network fixture independent.
					const request = httpRequest(url, { method: 'POST', signal }, response => {
						response.resume();
						response.on('end', () => resolve({ success: response.statusCode === 202, status: response.statusCode }));
					});
					request.on('error', reject); request.end(current.body);
				}) });
			await worker().drain(); expect(received).toHaveLength(0);
			await app.reopen(); now += 5000; available = true;
			await worker().drain(); expect(received).toEqual([row.body]);
			expect((await app.store.get(row.id))?.status).toBe('succeeded');
		} finally { await server.stop(true); }
	});

	test('persists HTTP 429 Retry-After rather than retrying early', async () => {
		const app = await fixture(engine, true), row = make(); await app.store.enqueue(row);
		let now = base, calls = 0;
		const worker = () => createNotificationOutboxWorker({ store: app.store, now: () => now,
			resolve: async () => 'https://receiver.example.org', send: async () => ++calls === 1 ? { success: false, status: 429, retryAfterMs: 37000 } : { success: true, status: 200 } });
		await worker().drain(); await app.reopen();
		now += 36999; await worker().drain(); expect(calls).toBe(1);
		now++; await worker().drain(); expect(calls).toBe(2);
		expect((await app.store.get(row.id))?.status).toBe('succeeded');
	});

	test('lease recovery rejects late results and competing workers cannot acquire the same job', async () => {
		const app = await fixture(engine, true), row = make(); await app.store.enqueue(row);
		const claims = await Promise.all([app.store.claim(base), app.store.claim(base)]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const old = claims.find(Boolean)!; await app.store.attempted(old, base);
		await app.reopen(); expect(await app.store.claim(base + 59999)).toBeNull();
		const fresh = await app.store.claim(base + 60000); expect(fresh?.id).toBe(row.id);
		expect(fresh?.leaseToken).not.toBe(old.leaseToken);
		expect(await app.store.finish(old, { status: 'succeeded' })).toBe(false);
		expect((await app.store.get(row.id))?.status).toBe('processing');
	});

	test('permanent failures remain inspectable and manual retry is conditional and preserves IDs', async () => {
		const app = await fixture(engine), row = make(); await app.store.enqueue(row);
		let result: WebhookAttemptResult = { success: false, status: 401 };
		const worker = createNotificationOutboxWorker({ store: app.store, now: () => base, resolve: async () => 'https://receiver.example.org', send: async () => result });
		await worker.drain(); expect((await app.store.get(row.id))?.status).toBe('failed');
		const retries = await Promise.all([app.store.retry(row.id, base, 3, 60), app.store.retry(row.id, base, 3, 60)]);
		expect(retries.filter(Boolean)).toHaveLength(1);
		result = { success: true }; await worker.drain();
		const delivered = await app.store.get(row.id);
		expect(delivered?.attempts).toBe(2); expect(delivered?.body).toBe(row.body); expect(delivered?.eventId).toBe(row.eventId);
		expect(await app.store.retry(row.id, base, 3, 60)).toBe(false);
	});

	test('expiry, attempt limit, cancellation and discard cannot send obsolete work', async () => {
		const app = await fixture(engine), expired = { ...make(), expiresAt: base }, limited = { ...make(), attempts: 10 }, cancelled = make(), discarded = make();
		for (const row of [expired, limited, cancelled, discarded]) await app.store.enqueue(row);
		expect(await app.store.discard(discarded.id, base)).toBe(true);
		let sent = 0;
		await createNotificationOutboxWorker({ store: app.store, now: () => base, resolve: async () => null, send: async () => { sent++; return { success: true }; } }).drain();
		expect(sent).toBe(0);
		for (const row of [expired, limited]) expect((await app.store.get(row.id))?.status).toBe('failed');
		expect((await app.store.get(cancelled.id))?.status).toBe('cancelled');
		expect((await app.store.get(discarded.id))?.status).toBe('discarded');
	});

	test('a lost processing lease does not erase a newer manual or worker result', async () => {
		const app = await fixture(engine), row = make(); await app.store.enqueue(row);
		const claimed = (await app.store.claim(base))!;
		expect(await app.store.discard(row.id, base)).toBe(false);
		expect(await app.store.retry(row.id, base, 3, 60)).toBe(false);
		await app.store.finish(claimed, { status: 'failed', finishedAt: base });
		await app.store.retry(row.id, base, 3, 60);
		expect(await app.store.finish(claimed, { status: 'succeeded' })).toBe(false);
		expect((await app.store.get(row.id))?.status).toBe('pending');
	});

	test('history is paginated, scoped, redacted and terminal retention is bounded', async () => {
		const app = await fixture(engine);
		for (let i = 0; i < 27; i++) await app.store.enqueue({ ...make(), environmentId: i % 2 ? 2 : 1 });
		expect((await app.store.list(1, 1)).items).toHaveLength(25);
		expect((await app.store.list(1, 2)).items).toHaveLength(2);
		expect((await app.store.list(1, 1, [])).total).toBe(0);
		const visible = await app.store.list(1, 1, [1]); expect(visible.total).toBe(14);
		const view = notificationDeliveryView(visible.items[0]);
		for (const key of ['body', 'destinationHash', 'leaseToken', 'leaseUntil']) expect(view).not.toHaveProperty(key);
		const row = { ...make(2), retentionDays: 1 }; await app.store.enqueue(row);
		await app.store.discard(row.id, base);
		await app.store.cleanup(base + 86400_001); expect(await app.store.get(row.id)).toBeNull();
	});

	test('channel deletion cascades and oversized payloads are never sent unrecorded', async () => {
		const app = await fixture(engine), row = make(); await app.store.enqueue(row);
		await app.run('DELETE FROM notification_settings WHERE id=1'); expect(await app.store.get(row.id)).toBeNull();
		await expect(app.store.enqueue({ ...make(2), body: 'x'.repeat(65537) })).rejects.toThrow('64 KiB');
	});
});

describe('notification outbox policies and authorization', () => {
	test('retry policy defaults off, validates all numeric bounds and rejects malformed input', () => {
		expect(notificationRetryPolicy(undefined).enabled).toBe(false);
		for (const input of [null, [], true, {}, { enabled: 'true' }, { enabled: true, maxAttempts: 0 }, { enabled: true, maxAgeMinutes: 10081 }, { enabled: false, retentionDays: 1.5 }]) expect(() => notificationRetryPolicy(input)).toThrow();
		expect(webhookRetryDelay(1, undefined, () => .5)).toBe(5000);
		expect(webhookRetryDelay(100, undefined, () => .5)).toBe(900000);
		expect(webhookRetryDelay(1, 37000)).toBe(37000);
		expect(retryAfterMilliseconds('37', base)).toBe(37000);
		expect(retryAfterMilliseconds(new Date(base + 60000).toUTCString(), base)).toBe(60000);
		expect(retryAfterMilliseconds('garbage', base)).toBeUndefined();
		expect(retryAfterMilliseconds('-10', base)).toBeUndefined();
	});

	test('snapshots never copy URL credentials or attachments and reject injected header IDs', () => {
		const row = createQueuedWebhook(1, 'jsons://user:private-token@receiver.example.org/secret-path', { ...event, attachments: [{ filename: 'secret.txt', content: Buffer.from('private-content') }] }, policy, 'environment', base);
		expect(row.body).not.toContain('private-token'); expect(row.body).not.toContain('private-content'); expect(row.body).not.toContain('secret-path');
		expect(JSON.parse(row.body).timestamp).toBe(event.timestamp);
		expect(notificationEventSnapshot({ ...event, eventId: 'x\r\nAuthorization: injected' }).eventId).toMatch(/^[a-f0-9-]{36}$/);
	});

	test('changed tokens/URLs, disabled channels, removed subscriptions and opt-out cancel retries', async () => {
		const row = make(), setting = { enabled: true, type: 'apprise', config: { urls: ['jsons://receiver.example.org/1'], retry: policy }, eventTypes: ['container_started'] };
		let current: typeof setting | null = setting, subscribed = true;
		const resolve = () => resolveWebhookDestination(row, { setting: async () => current, links: async () => subscribed ? [{ notificationId: 1 }] : [] });
		expect(await resolve()).toBe(setting.config.urls[0]);
		subscribed = false; expect(await resolve()).toBeNull(); subscribed = true;
		current = { ...setting, enabled: false }; expect(await resolve()).toBeNull();
		current = { ...setting, config: { ...setting.config, urls: ['jsons://receiver.example.org/changed'] } }; expect(await resolve()).toBeNull();
		current = { ...setting, config: { ...setting.config, retry: { ...policy, enabled: false } } }; expect(await resolve()).toBeNull();
		current = null; expect(await resolve()).toBeNull();
		const system = { ...row, scope: 'system' as const, environmentId: null, eventType: 'license_expiring' };
		expect(await resolveWebhookDestination(system, { setting: async () => setting, links: async () => [] })).toBeNull();
	});

	test('history actions enforce notification rights and per-environment access', async () => {
		const row = make();
		const auth = (overrides: object = {}): any => ({ authEnabled: true, isAuthenticated: true, can: async () => true, canAccessEnvironment: async () => true, getAccessibleEnvironmentIds: async () => null, ...overrides });
		expect(await requireNotificationDeliveryAccess(auth(), row, 'edit')).toBeNull();
		expect((await requireNotificationDeliveryAccess(auth({ can: async () => false }), row, 'edit'))?.status).toBe(403);
		expect((await requireNotificationDeliveryAccess(auth({ isAuthenticated: false }), row, 'view'))?.status).toBe(401);
		expect((await requireNotificationDeliveryAccess(auth({ canAccessEnvironment: async () => false }), row, 'edit'))?.status).toBe(403);
		expect((await requireNotificationDeliveryAccess(auth({ getAccessibleEnvironmentIds: async () => [1] }), { ...row, environmentId: null }, 'edit'))?.status).toBe(403);
	});
});
