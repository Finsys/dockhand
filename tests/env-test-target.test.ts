import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTestTarget } from '../src/lib/server/env-test-target';

// A connection test dials exactly the target its guard judged.
const noDns = async () => [] as string[];

describe('resolveTestTarget', () => {
	test.each([
		['LAN IP over http', { host: '192.168.1.7', port: 2375 }, 'http://192.168.1.7:2375'],
		['LAN IP over https', { protocol: 'https', host: '10.0.0.5', port: 2376 }, 'http://10.0.0.5:2376'],
		['hostname, default port', { host: 'docker.lan' }, 'http://docker.lan:2375'],
		['upper-case hostname', { host: 'Docker.LAN', port: 2375 }, 'http://docker.lan:2375'],
		['bracketed IPv6', { host: '[fd00::5]', port: 2375 }, 'http://[fd00::5]:2375'],
		['port as a numeric string', { host: '10.0.0.5', port: '2376' }, 'http://10.0.0.5:2376']
	])('allows %s', async (_n, config, origin) => {
		const r = await resolveTestTarget(config, noDns);
		expect(r).toMatchObject({ ok: true, origin });
	});

	test.each(['http:/x', 'https:/x', 'http://x/', 'ftp', 'HTTP', 'file', ' http'])(
		'refuses protocol %p',
		async (protocol) => {
			const r = await resolveTestTarget({ protocol, host: '10.0.0.5', port: 2375 }, noDns);
			expect(r).toMatchObject({ ok: false, badRequest: true });
		}
	);

	test.each(['x@10.0.0.5', '10.0.0.5/x', '10.0.0.5#x', '10.0.0.5?x', 'a\\b', '127.1', '0x7f000001', '10.0.0.5:99'])(
		'refuses host %p that the URL parser would rewrite',
		async (host) => {
			const r = await resolveTestTarget({ host, port: 2375 }, noDns);
			expect(r).toMatchObject({ ok: false, badRequest: true });
		}
	);

	test.each([-1, 65536, 1.5, 'x', '2375/x'])('refuses port %p', async (port) => {
		const r = await resolveTestTarget({ host: '10.0.0.5', port: port as number }, noDns);
		expect(r).toMatchObject({ ok: false, badRequest: true });
	});

	test.each(['127.0.0.1', '169.254.169.254', 'localhost', '[::1]'])('refuses blocked host %p', async (host) => {
		const r = await resolveTestTarget({ host, port: 2375 }, noDns);
		expect(r).toMatchObject({ ok: false, badRequest: false });
	});

	test('refuses a name that resolves to loopback or metadata, allows one that resolves to the LAN', async () => {
		const to = (addr: string) => async () => [addr];
		expect(await resolveTestTarget({ host: 'docker.lan' }, to('127.0.0.1'))).toMatchObject({ ok: false, badRequest: false });
		expect(await resolveTestTarget({ host: 'docker.lan' }, to('169.254.169.254'))).toMatchObject({ ok: false, badRequest: false });
		expect(await resolveTestTarget({ host: 'docker.lan' }, to('192.168.1.7'))).toMatchObject({ ok: true });
	});

	test('requires a host', async () => {
		expect(await resolveTestTarget({ host: '' }, noDns)).toMatchObject({ ok: false, badRequest: true });
	});
});

// The route cannot be imported here (it pulls in the database), so its wiring is read
// from the source: both plain requests use the checked origin, and the caller needs
// environments:create or :edit.
describe('environments/test route wiring', () => {
	const src = readFileSync(join(import.meta.dir, '..', 'src', 'routes', 'api', 'environments', 'test', '+server.ts'), 'utf8');
	const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

	test('every plain fetch goes to the checked origin', () => {
		const fetches = code.match(/fetch\(`[^`]*`/g) ?? [];
		expect(fetches).toEqual(['fetch(`${origin}/info`', 'fetch(`${origin}/_hawser/info`']);
		expect(code).toContain('origin = target.origin;');
		expect(code).toMatch(/if \(!target\.ok\) \{\s*if \(target\.badRequest\) return json\([^;]*\{ status: 400 \}\);\s*return json\([^;]*\{ status: 200 \}\)/);
	});

	test('neither plain fetch follows a redirect', () => {
		const calls = code.match(/fetch\(`\$\{origin\}[^`]*`, \{[^}]*\}/g) ?? [];
		expect(calls).toHaveLength(2);
		for (const c of calls) expect(c).toContain("redirect: 'manual'");
	});

	test('the caller needs environments:create or environments:edit', () => {
		expect(code).toMatch(
			/if \(auth\.authEnabled && !\(await auth\.can\('environments', 'create'\)\) && !\(await auth\.can\('environments', 'edit'\)\)\) \{\s*return json\(\{ success: false, error: 'Access denied' \}, \{ status: 403 \}\)/
		);
	});
});
