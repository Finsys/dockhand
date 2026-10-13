import { describe, expect, test } from 'bun:test';
import { targetsOwnContainer } from '../src/lib/server/own-container-core';

/**
 * Recognising the container Dockhand itself runs in.
 *
 * Changing its networking is not the same act as changing an application's: the
 * update helper reconnects the replacement to whatever it finds attached, so what is
 * attached here is read back by a privileged step. Attaching a network is its own
 * permission, so without this an account holding it could arrange that input without
 * holding the administrator role.
 *
 * The comparison is id to id. Docker takes a container NAME wherever it takes an id,
 * so the caller resolves what it was given before asking.
 */

const LONG = 'a'.repeat(64);
const SHORT = LONG.slice(0, 12);

describe('the same container', () => {
	test('the identical id', () => {
		expect(targetsOwnContainer(LONG, { id: LONG })).toBe(true);
	});

	test('a short id against the long one, and the reverse', () => {
		// A caller may hold either form; docker treats them as the same container.
		expect(targetsOwnContainer(SHORT, { id: LONG })).toBe(true);
		expect(targetsOwnContainer(LONG, { id: SHORT })).toBe(true);
	});

	test('case does not hide it', () => {
		expect(targetsOwnContainer(LONG.toUpperCase(), { id: LONG })).toBe(true);
	});
});

describe('some other container', () => {
	test('a different id', () => {
		expect(targetsOwnContainer('b'.repeat(64), { id: LONG })).toBe(false);
	});

	test('an id differing only in the last character of the short form', () => {
		// The near miss: the comparison runs over the shorter length, so this says
		// whether it compares at all rather than matching any prefix.
		expect(targetsOwnContainer(SHORT.slice(0, 11) + 'b', { id: LONG })).toBe(false);
	});
});

describe('anything that is not a resolved id', () => {
	test('a name never matches, however it is spelled', () => {
		// Docker accepts these wherever it accepts an id, so the caller must resolve
		// one to an id first; comparing the string it was handed is not the same test.
		for (const ref of ['dockhand', '/dockhand', 'DOCKHAND']) {
			expect(targetsOwnContainer(ref, { id: LONG })).toBe(false);
		}
	});

	test('a short non-hex string is not treated as an id', () => {
		expect(targetsOwnContainer('aaaaaaaaaaaz', { id: LONG })).toBe(false);
	});

	test('empty and non-string values', () => {
		for (const v of ['', '   ', null, undefined]) {
			expect(targetsOwnContainer(v as string, { id: LONG })).toBe(false);
		}
	});
});

describe('when our own identity is unknown', () => {
	test('nothing matches, so unrelated containers stay manageable', () => {
		// getOwnContainerId returns null outside Docker or where cgroup cannot be read.
		expect(targetsOwnContainer(LONG, { id: null })).toBe(false);
		expect(targetsOwnContainer(LONG, {})).toBe(false);
	});
});

describe('the guard is wired into both network endpoints', () => {
	// Those routes reach the database through better-sqlite3, which bun cannot load,
	// so the source is the available instrument. A guard that is written and never
	// called reads exactly like one that works.
	const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

	for (const route of ['connect', 'disconnect'] as const) {
		test(`${route} refuses a non-admin aiming at the Dockhand container`, async () => {
			const src = await read(`../src/routes/api/networks/[id]/${route}/+server.ts`);
			// The whole condition, not its parts: `false && refuse(...)` would mention
			// every piece while refusing nobody.
			expect(src).toMatch(
				/if \(auth\.authEnabled && !auth\.isAdmin\) \{\s*const denied = await refuseOwnContainer\(containerId, envIdNum\);\s*if \(denied\) return denied;/
			);
			// Fail-closed: the refusal must precede the docker call, not follow it.
			const guard = src.indexOf('refuseOwnContainer');
			const action = src.indexOf(
				route === 'connect' ? 'connectContainerToNetwork(' : 'disconnectContainerFromNetwork('
			);
			expect(guard).toBeGreaterThan(-1);
			expect(action).toBeGreaterThan(-1);
			expect(guard).toBeLessThan(action);
		});
	}

	test('the guard resolves the reference before comparing it', async () => {
		// Comparing the caller's string directly is what lets a name walk past: docker
		// resolves it, so the guard has to resolve it too.
		const src = await read('../src/lib/server/own-container-guard.ts');
		expect(src).toContain('await inspectContainer(containerRef, envId)');
		// The comparison decides the 403, and nothing returns ahead of it: an early
		// `return null` would leave every assertion above true while refusing nobody.
		const body = src.slice(src.indexOf('export async function refuseOwnContainer'));
		const compare = body.indexOf('targetsOwnContainer(resolvedId');
		const earlyReturns = [...body.slice(0, compare).matchAll(/^\treturn /gm)];
		expect(earlyReturns).toHaveLength(0);
		expect(body).toMatch(
			/if \(!targetsOwnContainer\(resolvedId, \{ id: ownId \}\)\) return null;\s*return json\(/
		);
	});
});
