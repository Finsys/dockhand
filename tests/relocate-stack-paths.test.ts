/**
 * Unit tests for the emergency relocate-stack-paths re-anchor rule (#904). The pure
 * shell functions in scripts/emergency/_relocate-common.sh carry the safety-critical
 * logic (boundary-safe prefix, "rewrite only when old missing AND new exists"), so we
 * exercise them by sourcing the library in `sh` and calling the functions directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(import.meta.dir, '../scripts/emergency/_relocate-common.sh');

// Run a snippet that sources the library and calls one of its functions.
async function sh(script: string, env: Record<string, string> = {}): Promise<string> {
	const proc = Bun.spawn(['sh', '-c', `. "${LIB}"\n${script}`], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

describe('rewrite_under_data_dir (shell)', () => {
	const OLD = '/app/data';
	const NEW = '/mnt/pool/dockhand';

	it('rewrites a path under the old DATA_DIR', async () => {
		const r = await sh(`rewrite_under_data_dir "${OLD}/stacks/web/dc.yml" "${OLD}" "${NEW}"`);
		expect(r).toBe(`${NEW}/stacks/web/dc.yml`);
	});

	it('rewrites the DATA_DIR root itself', async () => {
		expect(await sh(`rewrite_under_data_dir "${OLD}" "${OLD}" "${NEW}"`)).toBe(NEW);
	});

	it('is segment-boundary safe: /app/data does not match /app/database', async () => {
		expect(await sh(`rewrite_under_data_dir "/app/database/x/dc.yml" "${OLD}" "${NEW}"`)).toBe('');
	});

	it('returns empty for a path outside the old DATA_DIR', async () => {
		expect(await sh(`rewrite_under_data_dir "/opt/immich/dc.yml" "${OLD}" "${NEW}"`)).toBe('');
	});

	it('tolerates a trailing slash on both dirs', async () => {
		const r = await sh(`rewrite_under_data_dir "${OLD}/stacks/a/.env" "${OLD}/" "${NEW}/"`);
		expect(r).toBe(`${NEW}/stacks/a/.env`);
	});

	it('returns empty when old == new (no-op)', async () => {
		expect(await sh(`rewrite_under_data_dir "${OLD}/x" "${OLD}" "${OLD}"`)).toBe('');
	});
});

describe('classify_path (shell, old-missing AND new-exists guard)', () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'relo-'));
		mkdirSync(join(dir, 'new/stacks/web'), { recursive: true });
		writeFileSync(join(dir, 'new/stacks/web/dc.yml'), 'x'); // new present
		mkdirSync(join(dir, 'old/stacks/api'), { recursive: true });
		writeFileSync(join(dir, 'old/stacks/api/dc.yml'), 'x'); // old still present
	});

	// classify_path reads OLD_DIR / NEW_DIR from the environment.
	const run = (stored: string, d: string) =>
		sh(`OLD_DIR="${d}/old"; NEW_DIR="${d}/new"; classify_path "${stored}"`);

	it('WILL_UPDATE when old missing and new exists', async () => {
		const r = await run(`${dir}/old/stacks/web/dc.yml`, dir);
		expect(r.split('\t')[0]).toBe('WILL_UPDATE');
	});

	it('SKIP oldexists when the old file still resolves', async () => {
		const r = await run(`${dir}/old/stacks/api/dc.yml`, dir);
		expect(r).toContain('SKIP');
		expect(r).toContain('oldexists');
	});

	it('SKIP newmissing when neither old nor new is on disk', async () => {
		const r = await run(`${dir}/old/stacks/ghost/dc.yml`, dir);
		expect(r).toContain('SKIP');
		expect(r).toContain('newmissing');
	});

	it('SKIP outside for a path not under the old DATA_DIR', async () => {
		const r = await run('/opt/x/dc.yml', dir);
		expect(r).toContain('SKIP');
		expect(r).toContain('outside');
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
