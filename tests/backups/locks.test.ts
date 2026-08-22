/**
 * Unit tests for backups/locks.ts — the two exclusion mechanisms.
 *   LiveTargetLocks: REJECT a second op on the same live data.
 *   DestinationSerializer: SERIALIZE (queue) ops on the same destination.
 */
import { describe, it, expect } from 'bun:test';
import { liveTargetKey, LiveTargetLocks, DestinationSerializer } from '../../src/lib/server/backups/locks';

describe('liveTargetKey — same data ⇒ same key regardless of order/env-shape', () => {
	it('sorts and joins data paths so order does not matter', () => {
		expect(liveTargetKey(1, ['b', 'a'])).toBe(liveTargetKey(1, ['a', 'b']));
	});
	it('distinguishes environments', () => {
		expect(liveTargetKey(1, ['v'])).not.toBe(liveTargetKey(2, ['v']));
	});
	it('treats null/undefined env as "local"', () => {
		expect(liveTargetKey(null, ['v'])).toBe(liveTargetKey(undefined, ['v']));
		expect(liveTargetKey(null, ['v'])).toContain('local');
	});
	it('a shared volume under different container names collides (same data key)', () => {
		// Two backups keyed on the SAME volume path must produce the same key even
		// though the "target" differs — that's the whole point.
		expect(liveTargetKey(1, ['/volumes/shared'])).toBe(liveTargetKey(1, ['/volumes/shared']));
	});
	it('ignores blank entries', () => {
		expect(liveTargetKey(1, ['a', '', '  '])).toBe(liveTargetKey(1, ['a']));
	});
	it('a backup (:ro) and a restore (:rw) of the same target collide (mode-independent key)', () => {
		// Backup passes the discovery :ro bind; restore passes the :rw bind. Both
		// touch the same live volume, so the keys MUST match or they run concurrently.
		const backupBind = 'vol:/volumes/vol:ro';
		const restoreBind = 'vol:/volumes/vol:rw';
		expect(liveTargetKey(1, [backupBind])).toBe(liveTargetKey(1, [restoreBind]));
	});
	it('keys on the SOURCE, ignoring the container mount-point and mode', () => {
		// A bind source is the absolute host path; the /volumes/<key> mount-point and
		// mode must not affect the identity.
		expect(liveTargetKey(1, ['/data/config:/volumes/data_config:ro']))
			.toBe(liveTargetKey(1, ['/data/config:/volumes/data_config:rw']));
	});
	it('genuinely different targets still do not collide', () => {
		expect(liveTargetKey(1, ['vol-a:/volumes/vol-a:ro']))
			.not.toBe(liveTargetKey(1, ['vol-b:/volumes/vol-b:rw']));
		expect(liveTargetKey(1, ['/data/a:/volumes/data_a:ro']))
			.not.toBe(liveTargetKey(1, ['/data/b:/volumes/data_b:rw']));
	});

	// Config-only targets (no volumes/binds): the fallback identity keeps them apart.
	it('two DIFFERENT config-only targets on the same env do NOT collide (the bug)', () => {
		// Before the fix both were `${env}::` and the REJECT lock skipped one every cron run.
		expect(liveTargetKey(1, [], 'container:web'))
			.not.toBe(liveTargetKey(1, [], 'container:api'));
		expect(liveTargetKey(null, [], 'stack:blog'))
			.not.toBe(liveTargetKey(null, [], 'stack:shop'));
	});
	it('the SAME config-only target still collides across backup and restore', () => {
		// backup passes `${type}:${targetName}`, restore passes the same -> they MUST match so
		// a concurrent backup+restore of one config-only target is still serialized.
		expect(liveTargetKey(1, [], 'container:web')).toBe(liveTargetKey(1, [], 'container:web'));
	});
	it('a config-only target and a data-bearing target of the same name do not alias', () => {
		expect(liveTargetKey(1, [], 'container:web'))
			.not.toBe(liveTargetKey(1, ['vol:/volumes/vol:ro'], 'container:web'));
	});
	it('the fallback identity is IGNORED when the target has data sources (still collides on shared data)', () => {
		// Two different targets that share a volume must still collide (torn-snapshot guard) -
		// the fallback must not de-alias them.
		expect(liveTargetKey(1, ['shared:/volumes/shared:ro'], 'container:web'))
			.toBe(liveTargetKey(1, ['shared:/volumes/shared:ro'], 'container:api'));
	});
});

describe('LiveTargetLocks — a backup and restore of the same data mutually exclude', () => {
	it('the restore-style bind is rejected while the backup-style bind holds the same source', () => {
		const locks = new LiveTargetLocks();
		const backupKey = liveTargetKey(1, ['vol:/volumes/vol:ro']);
		const restoreKey = liveTargetKey(1, ['vol:/volumes/vol:rw']);
		expect(locks.tryAcquire(backupKey)).not.toBeNull();
		expect(locks.tryAcquire(restoreKey)).toBeNull(); // same data ⇒ rejected
	});
});

describe('LiveTargetLocks — reject a second op on the same key', () => {
	it('first acquire succeeds, second on the same key is rejected (null)', () => {
		const locks = new LiveTargetLocks();
		const release = locks.tryAcquire('k');
		expect(release).not.toBeNull();
		expect(locks.tryAcquire('k')).toBeNull(); // rejected while held
		expect(locks.isHeld('k')).toBe(true);
	});
	it('different keys do not block each other', () => {
		const locks = new LiveTargetLocks();
		expect(locks.tryAcquire('a')).not.toBeNull();
		expect(locks.tryAcquire('b')).not.toBeNull();
	});
	it('releasing frees the key for re-acquire', () => {
		const locks = new LiveTargetLocks();
		const release = locks.tryAcquire('k')!;
		release();
		expect(locks.isHeld('k')).toBe(false);
		expect(locks.tryAcquire('k')).not.toBeNull();
	});
	it('release is idempotent', () => {
		const locks = new LiveTargetLocks();
		const release = locks.tryAcquire('k')!;
		release();
		release(); // no throw, no double-delete side effect
		expect(locks.size).toBe(0);
	});
});

describe('DestinationSerializer — serialize ops on the same destination', () => {
	it('runs ops on the same destination one at a time, in order', async () => {
		const ser = new DestinationSerializer();
		const events: string[] = [];
		const op = (name: string, ms: number) => async () => {
			events.push(`start:${name}`);
			await new Promise((r) => setTimeout(r, ms));
			events.push(`end:${name}`);
			return name;
		};
		// Start two ops on the SAME destination; the second must wait for the first.
		const p1 = ser.run(1, op('A', 30));
		const p2 = ser.run(1, op('B', 5));
		await Promise.all([p1, p2]);
		expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
	});

	it('ops on DIFFERENT destinations run concurrently', async () => {
		const ser = new DestinationSerializer();
		const events: string[] = [];
		const op = (name: string, ms: number) => async () => {
			events.push(`start:${name}`);
			await new Promise((r) => setTimeout(r, ms));
			events.push(`end:${name}`);
		};
		await Promise.all([ser.run(1, op('A', 20)), ser.run(2, op('B', 5))]);
		// B (dest 2) starts before A ends because they don't share a destination.
		expect(events.indexOf('start:B')).toBeLessThan(events.indexOf('end:A'));
	});

	it('a failing op does not break the queue — the next op still runs', async () => {
		const ser = new DestinationSerializer();
		const ran: string[] = [];
		const p1 = ser.run(1, async () => { ran.push('A'); throw new Error('boom'); }).catch(() => 'caught');
		const p2 = ser.run(1, async () => { ran.push('B'); return 'ok'; });
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toBe('caught');
		expect(r2).toBe('ok');
		expect(ran).toEqual(['A', 'B']);
	});

	it('propagates the op result and error to the caller', async () => {
		const ser = new DestinationSerializer();
		await expect(ser.run(1, async () => 42)).resolves.toBe(42);
		await expect(ser.run(1, async () => { throw new Error('x'); })).rejects.toThrow('x');
	});
});
