/**
 * Dockhand's own container holds its database, encryption key and Docker socket, so exec,
 * the file browser and the terminal there are administrator territory. The handlers load
 * docker.ts / auth.ts and cannot run under bun; this pins that each one consults the guard
 * for non-admins before acting (the id comparison itself is covered by own-container-core).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const ROUTES = ['exec', 'exec/run', 'shells', 'files', 'files/chmod', 'files/chown', 'files/content',
	'files/create', 'files/delete', 'files/download', 'files/rename', 'files/upload'];

describe("exec and file access to Dockhand's own container", () => {
	test.each(ROUTES)('containers/[id]/%s refuses non-admins on the Dockhand container', (r) => {
		const src = readFileSync(`src/routes/api/containers/[id]/${r}/+server.ts`, 'utf8');
		const handlers = src.split(/\nexport const /).slice(1);
		expect(handlers.length).toBeGreaterThan(0);
		for (const h of handlers) {
			expect(h).toMatch(/if \(auth\.authEnabled && !auth\.isAdmin\) \{\s+const denied = await refuseOwnContainer\(params\.id, envId(Num)?\);\s+if \(denied\) return denied;/);
		}
	});

	test.each([
		['containers/[id]/inspect', 'containerData', 'return json({ ...containerData, divergence })'],
		['containers/[id]', 'details', 'return json(details)'],
		['containers/[id]/compose', 'containerData', 'inspectToCompose(']
	])("%s masks the env values of Dockhand's own container for non-admins", (route, v, use) => {
		// Comments stripped, so a commented-out call does not count.
		const src = readFileSync(`src/routes/api/${route}/+server.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		// Its own statement, so an `if (...)` prefix or a string does not count.
		const at = src.search(new RegExp(`^\\s*(const ownEnvMasked = )?maskOwnContainerEnv\\(${v}, getOwnContainerId\\(\\), !auth\\.authEnabled \\|\\| auth\\.isAdmin\\);$`, 'm'));
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(src.indexOf(use));
	});

	test("compose masks the image env alike, so Dockhand's inherited env stays out of the user-set view", () => {
		const src = readFileSync('src/routes/api/containers/[id]/compose/+server.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		const at = src.search(/^\s*if \(ownEnvMasked && imageEnv\) imageEnv = maskEnvValues\(imageEnv\);$/m);
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(src.indexOf('inspectToCompose('));
	});

	test('the terminal upgrade refuses another origin before it looks at auth', () => {
		const src = readFileSync('src/lib/server/ws-auth.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		const fn = src.slice(src.indexOf('export async function authenticateWsUpgrade'));
		const gate = fn.search(
			/^\s*if \(\s*isForbiddenCrossOriginUpgrade\(\{\s*origin: pickHeader\(headers, 'origin'\) \?\? null,\s*secFetchSite: pickHeader\(headers, 'sec-fetch-site'\) \?\? null,\s*host: pickHeader\(headers, 'host'\) \?\? null,\s*trustedOrigins: WS_TRUSTED_ORIGINS,\s*disabled: WS_ORIGIN_CHECK_DISABLED\s*\}\)\s*\) \{\s*console\.warn\((?:(?!\);)[\s\S])*\);\s*return null;\s*\}/m
		);
		expect(gate).toBeGreaterThan(-1);
		expect(gate).toBeLessThan(fn.indexOf('await isAuthEnabled()'));
	});

	test('both terminal WebSocket handlers consult the own-container hook', () => {
		expect(readFileSync('server.js', 'utf8')).toMatch(
			/if \(typeof globalThis\.__refusesOwnContainerForUser === 'function'\) \{\s+try \{\s+if \(await globalThis\.__refusesOwnContainerForUser\(ws\.__auth, [^)]*\), envId\)\) \{[\s\S]{0,200}ws\.close\(1008, 'own container'\);\s+return;/
		);
		expect(readFileSync('vite.config.ts', 'utf8')).toMatch(
			/const ownFn = \(globalThis as any\)\.__refusesOwnContainerForUser;\s+if \(typeof ownFn === 'function' && await ownFn\(wsAuth, [^)]*\), envId\)\) \{[\s\S]{0,200}ws\.close\(1008, 'own container'\);\s+return;/
		);
		// ws-auth.ts loads the database and cannot run under bun: pin the decision itself.
		expect(readFileSync('src/lib/server/ws-auth.ts', 'utf8')).toMatch(
			/if \(auth\.authDisabled \|\| auth\.isAdmin\) return false;\s+return isOwnContainer\(containerRef, environmentId \?\? undefined\);/
		);
		expect(readFileSync('src/lib/server/ws-auth.ts', 'utf8')).toContain(
			'globalThis.__refusesOwnContainerForUser = refusesOwnContainerForUser;'
		);
	});
});
