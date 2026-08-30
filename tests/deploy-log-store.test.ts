import { describe, expect, test } from 'bun:test';
import { runLogFileName } from '../src/lib/server/deploy-log-store';

describe('runLogFileName', () => {
	test('builds a name from a plain run id', () => {
		expect(runLogFileName('a1b2c3')).toBe('a1b2c3.log');
	});

	test('rejects anything that is not a plain id, so a run id can never become a path', () => {
		// The run id reaches this function from a route parameter. A traversal attempt must
		// throw rather than resolve to a file outside the log directory.
		expect(() => runLogFileName('../../etc/passwd')).toThrow();
		expect(() => runLogFileName('a/b')).toThrow();
		expect(() => runLogFileName('')).toThrow();
	});
});
