// POST /api/registries/test with an inline url judges the origin it dials and does not
// follow a redirect. The route cannot be imported here (it pulls in the database), so
// the wiring is read from the source.
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'src', 'routes', 'api', 'registries', 'test', '+server.ts'), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('registries/test wiring', () => {
	test('the inline check judges apiBase, by literal and by DNS', () => {
		expect(code).toContain('const safety = isSafeNotificationUrl(apiBase);');
		expect(code).toContain('await resolvedHostReason(new URL(apiBase).hostname)');
		expect(code).toMatch(/if \(reason\) \{\s*return json/);
		expect(code.indexOf('isSafeNotificationUrl(apiBase)')).toBeLessThan(code.indexOf('fetch('));
	});

	test('every fetch goes to apiBase and an inline url does not follow redirects', () => {
		const calls = code.match(/fetch\(`[^`]*`, \{[^}]*\{[^}]*\}[^}]*\}|fetch\(`[^`]*`, \{[^}]*\}/g) ?? [];
		expect(calls).toHaveLength(2);
		for (const c of calls) {
			expect(c).toContain('fetch(`${apiBase}/v2/`');
			expect(c).toMatch(/\bredirect,/);
		}
		expect(code).toContain("const redirect: RequestRedirect = inline ? 'manual' : 'follow';");
		expect(code).toContain('const inline = !data.registryId;');
	});

	test('a 3xx on the ping is reported, not treated as reachable', () => {
		expect(code).toMatch(/if \(pingResp\.status >= 300 && pingResp\.status < 400\) \{[\s\S]*?success: false/);
	});
});
