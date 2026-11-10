import { and, or, eq, lte, lt, asc, desc, inArray, sql, count } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { NotificationDelivery, NotificationDeliveryStatus } from '$lib/utils/notification-retries';

const active = ['pending', 'processing'];
const terminal = ['succeeded', 'failed', 'cancelled', 'discarded'];
export const NOTIFICATION_OUTBOX_LIMIT = 10000;
export const NOTIFICATION_DELIVERY_LEASE_MS = 60000;

/** Same Drizzle operations for SQLite and PostgreSQL. Injected for real-database tests. */
export function createNotificationOutboxStore(db: any, table: any) {
	const get = async (id: string): Promise<NotificationDelivery | null> =>
		(await db.select().from(table).where(eq(table.id, id)).limit(1))[0] ?? null;

	return {
		get,
		async enqueue(row: NotificationDelivery): Promise<void> {
			const total = await db.select({ count: count() }).from(table).where(inArray(table.status, active));
			if (Number(total[0].count) >= NOTIFICATION_OUTBOX_LIMIT) throw new Error('Notification webhook queue is full');
			if (Buffer.byteLength(row.body, 'utf8') > 65536) throw new Error('Notification webhook payload exceeds 64 KiB');
			await db.insert(table).values(row);
		},
		async claim(now: number, id?: string): Promise<NotificationDelivery | null> {
			const available = and(
				or(and(eq(table.status, 'pending'), lte(table.dueAt, now)), and(eq(table.status, 'processing'), lte(table.leaseUntil, now))),
				id ? eq(table.id, id) : undefined
			);
			for (let collision = 0; collision < 4; collision++) {
				const row = (await db.select().from(table).where(available).orderBy(asc(table.dueAt)).limit(1))[0];
				if (!row) return null;
				// Conditional UPDATE is the lease acquisition, not the preceding SELECT.
				const claimed = await db.update(table).set({
					status: 'processing', leaseToken: randomUUID(), leaseUntil: now + NOTIFICATION_DELIVERY_LEASE_MS
				}).where(and(eq(table.id, row.id), available)).returning();
				if (claimed[0]) return claimed[0];
				if (id) return null;
			}
			return null;
		},
		async attempted(row: NotificationDelivery, now: number): Promise<NotificationDelivery | null> {
			const rows = await db.update(table).set({ attempts: sql`${table.attempts} + 1`, leaseUntil: now + NOTIFICATION_DELIVERY_LEASE_MS })
				.where(and(eq(table.id, row.id), eq(table.status, 'processing'), eq(table.leaseToken, row.leaseToken))).returning();
			return rows[0] ?? null;
		},
		async finish(row: NotificationDelivery, patch: Partial<NotificationDelivery>): Promise<boolean> {
			const rows = await db.update(table).set({ ...patch, leaseUntil: null, leaseToken: null })
				.where(and(eq(table.id, row.id), eq(table.status, 'processing'), eq(table.leaseToken, row.leaseToken))).returning({ id: table.id });
			return rows.length === 1;
		},
		async list(notificationId: number, page = 1, environmentIds?: number[] | null): Promise<{ items: NotificationDelivery[]; total: number; page: number; pages: number }> {
			const visible = and(eq(table.notificationId, notificationId), environmentIds ? inArray(table.environmentId, environmentIds) : undefined);
			const total = Number((await db.select({ count: count() }).from(table).where(visible))[0].count);
			const items = await db.select().from(table).where(visible).orderBy(desc(table.createdAt), desc(table.id)).limit(25).offset((page - 1) * 25);
			return { items, total, page, pages: Math.max(1, Math.ceil(total / 25)) };
		},
		async retry(id: string, now: number, maxAttempts: number, maxAgeMinutes: number): Promise<boolean> {
			const rows = await db.update(table).set({ status: 'pending', dueAt: now, expiresAt: now + maxAgeMinutes * 60000,
				maxAttempts: sql`${table.attempts} + ${maxAttempts}`, finishedAt: null, lastError: null, httpStatus: null,
				leaseUntil: null, leaseToken: null })
				.where(and(eq(table.id, id), eq(table.status, 'failed'))).returning({ id: table.id });
			return rows.length === 1;
		},
		async discard(id: string, now: number): Promise<boolean> {
			const rows = await db.update(table).set({ status: 'discarded', finishedAt: now, lastError: null })
				.where(and(eq(table.id, id), inArray(table.status, ['pending', 'failed', 'cancelled']))).returning({ id: table.id });
			return rows.length === 1;
		},
		async cleanup(now: number): Promise<void> {
			// Expired events never start a fresh delivery after a long receiver outage.
			await db.update(table).set({ status: 'failed', finishedAt: now, lastError: 'Delivery expired', leaseUntil: null, leaseToken: null })
				.where(and(lte(table.expiresAt, now), or(eq(table.status, 'pending'), and(eq(table.status, 'processing'), lte(table.leaseUntil, now)))));
			await db.delete(table).where(and(inArray(table.status, terminal),
				lt(sql`${table.finishedAt} + ${table.retentionDays} * 86400000`, now)));
		}
	};
}

export type NotificationOutboxStore = ReturnType<typeof createNotificationOutboxStore>;
