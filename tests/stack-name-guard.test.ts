import { describe, expect, test } from 'bun:test';
import { isValidStackName } from '../src/lib/server/stack-name-guard';

/**
 * The gate every stack route runs before joining the route name into a filesystem path.
 * A name must be a plain Docker Compose project name; anything with a separator or a dot
 * is refused so it can only ever address a child of the stacks root.
 */
describe('a stack name is accepted only in its plain form', () => {
	test('a real compose project name is accepted', () => {
		for (const name of ['local2', 'my-stack', 'my_stack', 'app123', 'n8n', 'tag1740']) {
			expect(isValidStackName(name)).toBe(true);
		}
	});

	test('a name carrying a separator is rejected', () => {
		for (const name of ['..', '.', '../db', 'a/b', 'a/../b', '1/x', '/etc/passwd', 'foo/bar']) {
			expect(isValidStackName(name)).toBe(false);
		}
	});

	test('a name is not decoded again, so a literal escape stays literal', () => {
		// The route param arrives already decoded and is used verbatim; a value still
		// carrying escape characters is not a valid name either.
		for (const name of ['%2e%2e', '%252e%252e', '%2e%2e%2fdb', '..%2fdb']) {
			expect(isValidStackName(name)).toBe(false);
		}
	});

	test('a dot is not an allowed character', () => {
		expect(isValidStackName('a.b')).toBe(false);
		expect(isValidStackName('1.2.3')).toBe(false);
		expect(isValidStackName('..')).toBe(false);
	});

	test('an empty name and leading punctuation are rejected', () => {
		for (const name of ['', '-stack', '_stack', '.hidden', 'UPPER']) {
			expect(isValidStackName(name)).toBe(false);
		}
	});
});
