/**
 * The edge-cap SAFEGUARD: transportCanStream decides stream (uncapped, O(1)) vs buffered
 * (capped) put-archive. If it ever reported a hawser-edge env as streamable, the uncapped
 * path would run over the WS transport that can't stream it -> OOM. This is the single
 * load-bearing predicate the streaming design rests on, so pin it exactly.
 */
import { describe, it, expect } from 'bun:test';
import { Readable } from 'node:stream';
import { transportCanStream, sanitizeArchivePath, withIdleWatchdog } from '../../src/lib/server/backups/put-archive-transport';

describe('transportCanStream - edge-cap safeguard', () => {
	it('is FALSE only for hawser-edge (the one transport that cannot stream)', () => {
		expect(transportCanStream({ connectionType: 'hawser-edge' })).toBe(false);
	});

	it('is TRUE for every streamable transport (socket, direct, hawser-standard, local)', () => {
		for (const connectionType of ['socket', 'direct', 'hawser-standard', undefined, null]) {
			expect(transportCanStream({ connectionType })).toBe(true);
		}
	});

	it('an unknown/new connection type defaults to streamable (fail-open is fine here: worst case a slow buffered fallback, never data loss)', () => {
		expect(transportCanStream({ connectionType: 'some-future-type' })).toBe(true);
	});
});

describe('sanitizeArchivePath - command/URL injection guard', () => {
	it('leaves a normal archive path untouched', () => {
		expect(sanitizeArchivePath('/volumes/__dockhand_stackdir__/compose.yaml')).toBe('/volumes/__dockhand_stackdir__/compose.yaml');
	});

	it('strips shell/URL metacharacters', () => {
		expect(sanitizeArchivePath('/x;rm -rf /')).toBe('/xrm -rf /');
		expect(sanitizeArchivePath('/a`b`c')).toBe('/abc');
		expect(sanitizeArchivePath('/a$(whoami)b')).toBe('/awhoamib');
		expect(sanitizeArchivePath('/a|b&c')).toBe('/abc');
		expect(sanitizeArchivePath('/a<b>c"d\'e\\f')).toBe('/abcdef');
	});
});

describe('withIdleWatchdog - aborts a stalled upload, lets a progressing one through', () => {
	it('destroys the stream with an error after idleMs of zero throughput', async () => {
		// A tar that produces nothing (or a receiver that never reads) -> no chunks flow -> abort.
		const stuck = new Readable({ read() { /* never push: simulates a stalled producer/reader */ } });
		const guarded = withIdleWatchdog(stuck, 'test', 40);
		guarded.resume(); // put it in flowing mode; still no data will ever arrive
		const err = await new Promise<Error | null>((resolve) => {
			guarded.on('error', (e) => resolve(e));
			guarded.on('end', () => resolve(null));
			setTimeout(() => resolve(null), 300);
		});
		expect(err).toBeInstanceOf(Error);
		expect(String(err?.message)).toContain('not reading');
	});

	it('does NOT abort while chunks keep flowing, and ends cleanly', async () => {
		// Emit a chunk every 15ms for ~90ms (idle window 40ms) - each chunk resets the timer.
		let n = 0;
		const src = new Readable({ read() {} });
		const iv = setInterval(() => { if (n++ < 6) src.push(Buffer.from('x')); else { clearInterval(iv); src.push(null); } }, 15);
		const guarded = withIdleWatchdog(src, 'test', 40);
		const chunks: Buffer[] = [];
		const outcome = await new Promise<'end' | Error>((resolve) => {
			guarded.on('data', (c) => chunks.push(c));
			guarded.on('end', () => resolve('end'));
			guarded.on('error', (e) => resolve(e));
		});
		expect(outcome).toBe('end');       // never tripped the idle timer
		expect(chunks.length).toBe(6);     // all data delivered
	});
});
