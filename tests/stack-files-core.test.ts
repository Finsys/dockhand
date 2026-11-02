import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDirFilesAsMap, reportSkippedStackFiles, StackPayloadTooLargeError } from '../src/lib/server/stack-files-core';

// Pins the exec-bit mode-capture plumbing: a stack dir is scanned into a files map
// plus a SPARSE modes map that must carry 0o755 for every executable file and nothing
// for the rest. A regression that drops the mode capture leaves modes empty and these
// assertions fail.
describe('readDirFilesAsMap - captures the exec bit into a sparse modes map', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'stack-files-core-'));
		writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
		chmodSync(join(dir, 'run.sh'), 0o755);
		writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n');
		chmodSync(join(dir, 'compose.yaml'), 0o644);
		writeFileSync(join(dir, 'plain.txt'), 'hello world\n');
		chmodSync(join(dir, 'plain.txt'), 0o644);
		mkdirSync(join(dir, 'scripts'));
		writeFileSync(join(dir, 'scripts', 'deploy.sh'), '#!/bin/sh\ntrue\n');
		chmodSync(join(dir, 'scripts', 'deploy.sh'), 0o755);
		// A binary file (invalid UTF-8) must round-trip as base64.
		writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x01]));
		chmodSync(join(dir, 'blob.bin'), 0o644);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('an executable file (0755) gets a 0o755 entry in modes', async () => {
		const { modes } = await readDirFilesAsMap(dir);
		expect(modes['run.sh']).toBe(0o755);
	});

	test('a non-executable file (0644) gets NO modes entry (sparse)', async () => {
		const { modes } = await readDirFilesAsMap(dir);
		expect('compose.yaml' in modes).toBe(false);
		expect('plain.txt' in modes).toBe(false);
		expect('blob.bin' in modes).toBe(false);
	});

	test('modes contains ONLY the executable files, nothing else', async () => {
		const { modes } = await readDirFilesAsMap(dir);
		expect(Object.keys(modes).sort()).toEqual(['run.sh', 'scripts/deploy.sh']);
	});

	test('a nested file keeps its relative path with forward slashes and its exec bit', async () => {
		const { files, modes } = await readDirFilesAsMap(dir);
		expect('scripts/deploy.sh' in files).toBe(true);
		expect(modes['scripts/deploy.sh']).toBe(0o755);
	});

	test('text content round-trips and binary content is base64-prefixed', async () => {
		const { files } = await readDirFilesAsMap(dir);
		expect(files['plain.txt']).toBe('hello world\n');
		expect(files['blob.bin'].startsWith('base64:')).toBe(true);
		expect(Buffer.from(files['blob.bin'].slice('base64:'.length), 'base64')).toEqual(
			Buffer.from([0x00, 0xff, 0xfe, 0x01])
		);
	});

	test('a clean dir returns an empty skipped array', async () => {
		const { skipped } = await readDirFilesAsMap(dir);
		expect(skipped).toEqual([]);
	});
});

// There is no per-file cap: a single large file is sent in full. Only the SUM of all
// files is bounded (256 MB), because the whole map is serialized into one string. A file
// larger than the old 10 MB per-file cap must now be INCLUDED, not silently dropped.
describe('readDirFilesAsMap - no per-file cap; large single file is included', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'stack-files-big-'));
		// 16 MB: strictly over the removed 10 MB per-file cap and over any plausible
		// boundary cap a regression might re-introduce, so this reliably fails if a
		// per-file cap comes back. Still well under the 256 MB total.
		writeFileSync(join(dir, 'big.bin'), Buffer.alloc(16 * 1024 * 1024, 0x41));
		writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n');
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a 16 MB file is included in the payload, not skipped', async () => {
		const { files, skipped } = await readDirFilesAsMap(dir);
		expect('big.bin' in files).toBe(true);
		expect(files['big.bin'].length).toBe(16 * 1024 * 1024);
		expect(skipped).toEqual([]);
	});
});

// A symlink cannot travel over the path->content protocol, so it is named in `skipped`
// with a reason the caller surfaces in the deploy log, rather than vanishing unremarked.
describe('readDirFilesAsMap - reports a skipped symlink with a reason', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'stack-files-skip-'));
		writeFileSync(join(dir, 'real.txt'), 'content\n');
		symlinkSync('real.txt', join(dir, 'link.txt'));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('the symlink is absent from files and present in skipped with its target', async () => {
		const { files, skipped } = await readDirFilesAsMap(dir);
		expect('link.txt' in files).toBe(false);
		expect(skipped.some((s) => s.startsWith('link.txt -> real.txt') && s.includes('symlink'))).toBe(true);
	});
});

// Exceeding the total cap FAILS the scan rather than sending a partial tree, because a
// half-deployed stack is the same silent failure this guard exists to prevent. The cap is
// injected small so this is testable without a 256 MB fixture.
describe('readDirFilesAsMap - exceeding the total cap throws', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'stack-files-total-'));
		writeFileSync(join(dir, 'a.bin'), Buffer.alloc(3 * 1024 * 1024, 0x41)); // 3 MB
		writeFileSync(join(dir, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 0x42)); // 6 MB -> busts a 5 MB cap
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a stack over the cap throws StackPayloadTooLargeError, not a partial payload', async () => {
		await expect(readDirFilesAsMap(dir, 5 * 1024 * 1024)).rejects.toThrow(StackPayloadTooLargeError);
	});

	test('the error names the transfer limit so the deploy failure is actionable', async () => {
		await expect(readDirFilesAsMap(dir, 5 * 1024 * 1024)).rejects.toThrow(/5 MB transfer limit/);
	});

	test('a stack within the cap returns normally with an empty skipped list', async () => {
		const { files, skipped } = await readDirFilesAsMap(dir, 64 * 1024 * 1024);
		expect('a.bin' in files).toBe(true);
		expect('big.bin' in files).toBe(true);
		expect(skipped).toEqual([]);
	});
});

// A file whose stored length is exactly the cap must be ACCEPTED (the check is strict '>',
// not '>='): a stack that fits to the byte should deploy. This pins the boundary so a
// '>' -> '>=' regression is caught.
describe('readDirFilesAsMap - a stack exactly at the cap is accepted', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'stack-files-exact-'));
		// 'A' is valid UTF-8 -> stored as text, so stored length == raw byte count.
		writeFileSync(join(dir, 'exact.txt'), Buffer.alloc(4 * 1024 * 1024, 0x41)); // exactly 4 MB stored
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a single file exactly at the cap is included, not rejected', async () => {
		const { files } = await readDirFilesAsMap(dir, 4 * 1024 * 1024); // cap == file size
		expect('exact.txt' in files).toBe(true);
	});

	test('one byte over the cap throws', async () => {
		await expect(readDirFilesAsMap(dir, 4 * 1024 * 1024 - 1)).rejects.toThrow(StackPayloadTooLargeError);
	});
});

// The budget counts the STORED length. A binary file is base64 (~1.33x), so a file whose
// RAW bytes fit the cap can still bust it once encoded - this must throw, matching the V8
// string ceiling the cap protects.
describe('readDirFilesAsMap - binary files are budgeted at their base64 size', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'stack-files-b64-'));
		// 3 MB of invalid-UTF-8 bytes -> base64 is ~4 MB stored (3 * 4/3). Raw fits a 3.5 MB
		// cap; base64 does not.
		const buf = Buffer.alloc(3 * 1024 * 1024);
		for (let i = 0; i < buf.length; i++) buf[i] = 0xff; // 0xff is not valid UTF-8
		writeFileSync(join(dir, 'blob.bin'), buf);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a 3 MB binary file throws against a 3.5 MB cap because base64 inflates it to ~4 MB', async () => {
		await expect(readDirFilesAsMap(dir, Math.floor(3.5 * 1024 * 1024))).rejects.toThrow(StackPayloadTooLargeError);
	});

	test('the same file fits a 5 MB cap', async () => {
		const { files } = await readDirFilesAsMap(dir, 5 * 1024 * 1024);
		expect(files['blob.bin'].startsWith('base64:')).toBe(true);
	});
});

// reportSkippedStackFiles surfaces an unsendable file (a symlink) as a visible deploy-log
// WARNING rather than a silent success. The forward sink can be undefined (no consumer).
describe('reportSkippedStackFiles - emits each skipped file as a deploy-log warning', () => {
	test('forwards one WARNING line per skipped entry', () => {
		const out: string[] = [];
		reportSkippedStackFiles(['link.txt -> real.txt (symlink; only regular files are sent)'], (l) => out.push(l));
		expect(out).toEqual([
			'WARNING: not sent to the remote host: link.txt -> real.txt (symlink; only regular files are sent)'
		]);
	});

	test('emits nothing for an empty or undefined skipped list', () => {
		const out: string[] = [];
		reportSkippedStackFiles([], (l) => out.push(l));
		reportSkippedStackFiles(undefined, (l) => out.push(l));
		expect(out).toEqual([]);
	});

	test('does not throw when there is no forward sink (undefined consumer)', () => {
		expect(() => reportSkippedStackFiles(['big.bin'], undefined)).not.toThrow();
	});
});
