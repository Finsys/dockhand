// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { analyzeHandlerBody } from '../scripts/openapi/lib';

// Gate 7 (body-field drift) compares these extracted fields against the @openapi
// body: annotation. The extraction must see BOTH destructuring and member access,
// and must NOT count a write to a local variable that happens to be named `body`.
describe('analyzeHandlerBody: request-body field extraction', () => {
	test('destructured fields', () => {
		const a = analyzeHandlerBody(`const { name, count } = await request.json();`);
		expect(a.bodyFields).toEqual(['count', 'name']);
	});

	test('member access (body.foo / body?.foo) is detected', () => {
		const a = analyzeHandlerBody(`
			const flags = body.backupFlags ?? body.restoreFlags;
			if (body?.mode === 'x') return;
		`);
		expect(a.bodyFields).toContain('backupFlags');
		expect(a.bodyFields).toContain('restoreFlags');
		expect(a.bodyFields).toContain('mode');
	});

	test('mixes destructure + member access', () => {
		const a = analyzeHandlerBody(`
			const { destinationId } = await request.json();
			const s = body.snapshotId;
		`);
		expect(a.bodyFields).toEqual(['destinationId', 'snapshotId']);
	});

	test('a WRITE to a local var named body is NOT a request field (the preview-env false positive)', () => {
		// This is the real shape from src/routes/api/git/preview-env: an error-response
		// object literally named `body`. Its assignments must not be read as body fields.
		const a = analyzeHandlerBody(`
			const body: Record<string, unknown> = { error: outcome.message };
			if (outcome.vars) body.vars = outcome.vars;
			if (outcome.sources) body.sources = outcome.sources;
			return json(body, { status: 400 });
		`);
		expect(a.bodyFields).not.toContain('vars');
		expect(a.bodyFields).not.toContain('sources');
	});

	test('a comparison (body.x ===) IS a read, still counted', () => {
		const a = analyzeHandlerBody(`if (body.mode === 'in-place') {}`);
		expect(a.bodyFields).toContain('mode');
	});

	test('request.body stream members are still captured here (Gate 7 filters them out separately)', () => {
		// analyzeHandlerBody is naive about `request.body.getReader()`; the STREAM_BODY_MEMBERS
		// allowlist in the drift checker is what prevents these from being flagged.
		const a = analyzeHandlerBody(`const r = request.body.getReader();`);
		expect(a.bodyFields).toContain('getReader');
	});

	test('compound / logical assignment to a local body is a WRITE, not a read', () => {
		// A local var named `body` mutated with +=, ??=, ||=, &&=, *= must not be counted
		// as a request-body read (would spuriously hard-fail the drift gate).
		const a = analyzeHandlerBody(`
			const body: Record<string, unknown> = {};
			body.count += 1;
			body.flag ??= true;
			body.acc ||= [];
			body.on &&= false;
			body.total *= 2;
		`);
		for (const f of ['count', 'flag', 'acc', 'on', 'total']) {
			expect(a.bodyFields).not.toContain(f);
		}
	});

	test('destructuring a NESTED object off body.member does not leak nested keys as top-level', () => {
		// `const { setting } = body.config;` reads config.setting, NOT a top-level `setting`.
		const a = analyzeHandlerBody(`const { setting } = body.config;`);
		expect(a.bodyFields).not.toContain('setting');
		// body.config itself IS a real top-level read
		expect(a.bodyFields).toContain('config');
	});

	test('a real field named like a Body method (body.text) IS captured (not masked here)', () => {
		// The extractor must surface body.text; only the narrowed STREAM_BODY_MEMBERS in
		// the drift checker skips true stream methods, and `text` is no longer in it.
		const a = analyzeHandlerBody(`const t = body.text;`);
		expect(a.bodyFields).toContain('text');
	});
});
