import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { parseEnvFileContent } from '../src/lib/server/env-file-content-core';

// .env files hold secrets. parseEnvFileContent() runs on every stack deploy and its output
// lands in `docker logs dockhand` and the in-app log viewer, so whatever shape a secret takes
// in the file, it must never reach the console.
// Every secret starts and ends with a marker, so a log that shows only part of a value
// (a prefix or suffix "hint") still gives it away.
const MARK = 'ZQX';
const SECRETS = {
	plain: `${MARK}plainS3cretValue1${MARK}`,
	quoted: `${MARK}quoted secret value 2${MARK}`,
	expanded: `${MARK}expandedS3cret3${MARK}`,
	commented: `${MARK}commentedOldS3cret4${MARK}`,
	noEquals: `${MARK}bodyLineS3cret5${MARK}`,
	padded: `${MARK}paddedS3cret6+abc/def${MARK}`,
	exported: `${MARK}exportedS3cret7${MARK}`,
	dashed: `${MARK}dashedKeyS3cret8${MARK}`
};

const FILE = [
	`DB_PASSWORD=${SECRETS.plain}`,
	`API_KEY="${SECRETS.quoted}"`,
	`PREFIX=${SECRETS.expanded}`,
	'DERIVED=${PREFIX}-suffix',
	`# OLD_TOKEN=${SECRETS.commented}`,
	`CERT_CHAIN="first line of a multi-line value`,
	SECRETS.noEquals,
	`${SECRETS.padded}==`,
	'last line of the value"',
	// Invalid keys with a secret value: the invalid-key note must not carry the value.
	`export DB_PASS=${SECRETS.exported}`,
	`my-token=${SECRETS.dashed}`,
	''
].join('\n');

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
	for (const s of spies.splice(0)) s.mockRestore();
});

function captureConsole(): () => string {
	const lines: string[] = [];
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
		}));
	}
	return () => lines.join('\n');
}

describe('parseEnvFileContent logging', () => {
	test('no secret from the file reaches the console, in any shape', () => {
		const output = captureConsole();
		parseEnvFileContent(FILE, 'demo');
		const logged = output();
		expect(logged.length).toBeGreaterThan(0);
		for (const [shape, secret] of Object.entries(SECRETS)) {
			expect({ shape, leaked: logged.includes(secret) }).toEqual({ shape, leaked: false });
		}
		expect(logged.includes(MARK)).toBe(false);
	});

	test('the same holds when values are not expanded', () => {
		const output = captureConsole();
		parseEnvFileContent(FILE, 'demo', { expand: false });
		const logged = output();
		for (const secret of Object.values(SECRETS)) expect(logged.includes(secret)).toBe(false);
		expect(logged.includes(MARK)).toBe(false);
	});

	test('keys, counts and line numbers are still logged for debugging', () => {
		const output = captureConsole();
		parseEnvFileContent(FILE, 'demo');
		const logged = output();
		expect(logged).toContain('DB_PASSWORD');
		expect(logged).toContain('API_KEY');
		expect(logged).toContain('Raw content length:');
		expect(logged).toMatch(/Line 5 \(comment\)/);
	});

	test('the values themselves are still parsed and returned', () => {
		captureConsole();
		const vars = parseEnvFileContent(FILE, 'demo');
		expect(vars.DB_PASSWORD).toBe(SECRETS.plain);
		expect(vars.API_KEY).toBe(SECRETS.quoted);
		expect(vars.DERIVED).toBe(`${SECRETS.expanded}-suffix`);
	});
});
