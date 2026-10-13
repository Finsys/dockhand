/**
 * The helper's LogConfig has to be a COMPLETE json-file configuration, not a partial
 * one: a partial Config inherits the daemon's log-opts, and `compress` from
 * /etc/docker/daemon.json combined with our `max-file: 1` is a combination the daemon
 * refuses outright ("compress cannot be true when max-file is less than 2"), so the
 * helper never starts and the scan fails (#1715).
 *
 * Asserted against the real source, since docker.ts cannot be imported here
 * (better-sqlite3 does not load under the test runner). The config is read out of the
 * source and then run through the daemon's own rule, so this pins the BEHAVIOUR - a
 * reformat or a key reorder keeps passing, and dropping an option does not.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'server', 'docker.ts'), 'utf8');

/** The LogConfig literal inside runContainerWithStreaming. */
function helperLogConfig(): Record<string, string> {
	const fn = SRC.indexOf('export async function runContainerWithStreaming');
	expect(fn).toBeGreaterThan(-1);
	const at = SRC.indexOf('LogConfig', fn);
	expect(at).toBeGreaterThan(-1);
	// Just the Config object, so the sibling `Type` cannot be read as an option.
	const open = SRC.indexOf('{', SRC.indexOf('Config:', at));
	const block = SRC.slice(open, SRC.indexOf('}', open));
	const config: Record<string, string> = {};
	for (const [, k, v] of block.matchAll(/'([a-z-]+)'\s*:\s*'([^']*)'/g)) config[k] = v;
	return config;
}

/**
 * The daemon's own validation of json-file options, from the error text it returns:
 * compress requires max-file >= 2 AND max-size set.
 */
function daemonRejects(config: Record<string, string>): string | null {
	if (config.compress !== 'true') return null;
	const maxFile = parseInt(config['max-file'] ?? '1', 10);
	if (maxFile < 2 || !config['max-size']) {
		return 'compress cannot be true when max-file is less than 2 or max-size is not set';
	}
	return null;
}

describe("the helper's log configuration", () => {
	test('names every option it relies on, so none is inherited from the daemon', () => {
		const config = helperLogConfig();
		// Each of the three decides whether the container can start at all once a
		// daemon-wide default exists for it.
		expect(Object.keys(config).sort()).toEqual(['compress', 'max-file', 'max-size']);
	});

	test('keeps one unrotated file, which is what the helper reads its result from', () => {
		const config = helperLogConfig();
		expect(config['max-file']).toBe('1');
		expect(config['max-size']).toBe('1g');
	});

	test('the daemon accepts it as written', () => {
		expect(daemonRejects(helperLogConfig())).toBeNull();
	});

	test('the daemon would refuse it if compress were inherited as true', () => {
		// The failure this configuration exists to prevent: the same max-file with
		// compress on is what a daemon-wide `"compress": "true"` produces.
		const inherited = { ...helperLogConfig(), compress: 'true' };
		expect(daemonRejects(inherited)).toContain('compress cannot be true');
	});
});
