import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveEnvValues } from '../src/lib/utils/env-file-values';

/**
 * Every value here was READ OUT OF A RUNNING CONTAINER after docker compose resolved
 * the same .env file, so the expectations are compose's real behaviour rather than a
 * reading of its documentation. The corpus covers quoting, comments, escapes, the
 * default and alternative operators against set / empty / unset names, nesting,
 * adjacency and stray dollars and braces.
 *
 * Regenerate by writing the inputs to a .env, resolving them with compose, and reading
 * the values back with `env -0` (NUL-separated, so a value containing a newline stays
 * one record).
 */
const corpus = JSON.parse(
	readFileSync(new URL('./fixtures/env-file-compose-corpus.json', import.meta.url), 'utf8')
) as { seed: Record<string, string>; cases: { input: string; expected: string }[] };

describe('every value compose was measured on', () => {
	test('the corpus is the size it was recorded at', () => {
		expect(corpus.cases.length).toBe(158);
	});

	// One assertion per case, so a failure names the input that broke rather than the
	// whole corpus.
	for (const [i, c] of corpus.cases.entries()) {
		test(`case ${i}: ${JSON.stringify(c.input)}`, () => {
			const entries: [string, string][] = [
				...Object.entries(corpus.seed),
				['SUBJECT', c.input]
			];
			expect(resolveEnvValues(entries).SUBJECT).toBe(c.expected);
		});
	}
});
