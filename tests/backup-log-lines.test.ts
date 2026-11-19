/**
 * Backup decisions that reach the browser only also reach the server log. The route
 * handlers and the engine load the database, which bun cannot, so these assertions pin
 * the log lines at the source level.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(import.meta.dir, '..', ...p), 'utf8');

describe('backup log lines', () => {
	it('a snapshot listing that fails is logged, redacted, on every listing path', () => {
		const src = read('src', 'routes', 'api', 'backup', 'snapshots', '+server.ts');
		expect(src).toContain('listing failed: ${redactUrlCredentials(msg)}');
		expect(src).toContain('logListingFailure(destinationId, configId, () =>');
		expect(src).toContain('logListingFailure(config.destinationId, config.id, () => listSnapshots(config.destinationId, config.id))');
		expect(src).toContain('failed: ${redactUrlCredentials(failed.join(\'; \'))}');
	});

	it('saving a config logs the schedule and enabled change, and a failed save', () => {
		const src = read('src', 'routes', 'api', 'backup', 'configs', '[id]', '+server.ts');
		expect(src).toContain('saved: schedule ${existing.schedule || \'manual\'} -> ${updated.schedule || \'manual\'}, enabled ${existing.enabled} -> ${updated.enabled} (sent ${body.enabled ?? \'nothing\'})');
		// A failed query's message carries its params (the options JSON with webhook URLs); log the driver's.
		expect(src).toContain('saving failed:`, error?.cause instanceof Error ? error.cause.message : error?.message);');
		expect(src).not.toContain('saving failed:`, error.message);');
	});

	it('the stack-dir plan says preview or backup, and logs deselections it ignores', () => {
		const src = read('src', 'lib', 'server', 'backups', 'index.ts');
		expect(src).toContain("const phase = capturedVolumeSources === undefined ? 'preview' : 'backup';");
		expect(src).toContain('ignored ${refused.length} deselection(s) the server never excludes');
		expect(src).not.toContain('console.log(`[Backup] stackdir "${targetName}": ');
	});
});
