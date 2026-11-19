import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { attachResolvedSecrets, RESOLVED_SECRETS_KEY } from '../src/lib/server/resolved-secrets';

/**
 * A deploy's result carries the plaintext of every secret that reached the container, so
 * the history recorder can redact them out of compose's output. The same object is
 * answered to a webhook caller and streamed to the browser, and a webhook reply is stored
 * in a git forge's delivery history and echoed by deploy scripts - so a secret on the wire
 * is a secret in a third party's log.
 */
describe('a deploy result keeps its secrets off the wire', () => {
	const SECRETS = ['wp-db-p@ssw0rd', 'woo-api-key-xyz'];
	const deployResult = () =>
		attachResolvedSecrets(
			{ success: true, output: 'Container started', exitCode: 0 },
			SECRETS
		);

	test('server code reads the values', () => {
		// This is the whole point of the field: the recorder needs it to redact.
		expect((deployResult() as { resolvedSecrets?: string[] }).resolvedSecrets).toEqual(SECRETS);
	});

	test('it attaches onto the caller\'s own object', () => {
		// deployStack discards the return value, and all five readers that feed the
		// recorder read the field off the object they passed in. A helper that attached to
		// a copy would leave every one of them reading undefined, so the recorder would
		// redact against nothing and a provider secret quoted in compose's error text
		// would be stored in the deploy log in cleartext - the wire leak traded for an
		// at-rest one, with the suite still green.
		const result: Record<string, unknown> = { success: true };
		const returned = attachResolvedSecrets(result, SECRETS);
		expect(returned).toBe(result);
		expect((result as { resolvedSecrets?: string[] }).resolvedSecrets).toEqual(SECRETS);
	});

	test('a webhook reply does not carry them', () => {
		// POST/GET /api/git/stacks/[id]/webhook answers json(result).
		const body = JSON.stringify(deployResult());
		expect(body).not.toContain('resolvedSecrets');
		for (const secret of SECRETS) expect(body).not.toContain(secret);
		expect(JSON.parse(body)).toEqual({ success: true, output: 'Container started', exitCode: 0 });
	});

	test('an SSE result event does not carry them', () => {
		// /api/git/stacks/[id]/deploy sends the result object straight through.
		const sent = JSON.stringify({ event: 'result', data: deployResult() });
		expect(sent).not.toContain('resolvedSecrets');
		for (const secret of SECRETS) expect(sent).not.toContain(secret);
	});

	test('a result nested in another payload does not carry them', () => {
		// POST /api/git/stacks answers { deployResult }.
		const sent = JSON.stringify({ deployResult: deployResult() });
		expect(sent).not.toContain('resolvedSecrets');
		for (const secret of SECRETS) expect(sent).not.toContain(secret);
	});

	test('a copy of the result does not carry them either', () => {
		// A route that spreads or clones before answering must not reintroduce the leak.
		const result = deployResult();
		for (const copy of [{ ...result }, structuredClone(result)]) {
			expect(JSON.stringify(copy)).not.toContain('resolvedSecrets');
			expect(Object.keys(copy)).not.toContain(RESOLVED_SECRETS_KEY);
		}
	});

	test('the field never shows up in an enumeration', () => {
		const result = deployResult();
		expect(Object.keys(result)).toEqual(['success', 'output', 'exitCode']);
		expect(Object.entries(result).map(([key]) => key)).not.toContain(RESOLVED_SECRETS_KEY);
		expect(JSON.stringify(Object.assign({}, result))).not.toContain(RESOLVED_SECRETS_KEY);
	});

	test('deployStack attaches it this way, not by assignment', () => {
		// A plain `result.resolvedSecrets = ...` is enumerable and would serialize, so the
		// deploy path must go through the helper. A unit test cannot load stacks.ts (it
		// pulls in better-sqlite3), so this reads the source.
		const stacks = readFileSync(new URL('../src/lib/server/stacks.ts', import.meta.url), 'utf8');
		expect(stacks).toContain('attachResolvedSecrets(result,');
		expect(stacks).not.toMatch(/result\.resolvedSecrets\s*=/);
	});
});
