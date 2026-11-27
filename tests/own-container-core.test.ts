import { describe, expect, test } from 'bun:test';
import { targetsOwnContainer, maskOwnContainerEnv, maskEnvValues } from '../src/lib/server/own-container-core';
import { inspectToCompose } from '../src/lib/utils/inspect-to-compose';
import yaml from 'js-yaml';

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
		// The comparison decides the answer, and nothing returns ahead of it: an early
		// `return false` would leave every assertion above true while refusing nobody.
		const own = src.slice(src.indexOf('export async function isOwnContainer'));
		const compare = own.indexOf('\treturn targetsOwnContainer(resolvedId');
		const earlyReturns = [...own.slice(0, compare).matchAll(/^\treturn /gm)];
		expect(earlyReturns).toHaveLength(0);
		expect(own).toMatch(/return targetsOwnContainer\(resolvedId, \{ id: ownId \}\);/);
		// refuseOwnContainer answers 403 exactly when isOwnContainer says so.
		const refuse = src.slice(src.indexOf('export async function refuseOwnContainer'), src.indexOf('export async function isOwnContainer'));
		expect(refuse).toMatch(/if \(!\(await isOwnContainer\(containerRef, envId\)\)\) return null;\s*return json\(/);
	});
});

describe('maskOwnContainerEnv', () => {
	const own = 'a'.repeat(64);
	const env = () => ['DATABASE_URL=postgres://u:secret@db/x', 'ENCRYPTION_KEY=k3y', 'NOVALUE', 'EMPTY='];
	const run = (id: string, privileged: boolean) => {
		const d = { Id: id, Config: { Env: env() } };
		maskOwnContainerEnv(d, own, privileged);
		return d.Config.Env;
	};

	test('a non-admin sees the keys of Dockhand own env but none of the values', () => {
		expect(run(own, false)).toEqual(['DATABASE_URL=***', 'ENCRYPTION_KEY=***', 'NOVALUE', 'EMPTY=***']);
		expect(maskOwnContainerEnv({ Id: own, Config: { Env: env() } }, own, false)).toBe(true);
		expect(maskOwnContainerEnv({ Id: own, Config: { Env: env() } }, own, true)).toBe(false);
	});

	test('maskEnvValues keeps keys and a value-less entry, and a value with = is hidden whole', () => {
		expect(maskEnvValues(['A=b', 'C', 'D=e=f'])).toEqual(['A=***', 'C', 'D=***']);
	});

	test('an admin, another container, or an unknown own id keep the values', () => {
		expect(run(own, true)).toEqual(env());
		expect(run('b'.repeat(64), false)).toEqual(env());
		const d = { Id: own, Config: { Env: env() } };
		maskOwnContainerEnv(d, null, false);
		expect(d.Config.Env).toEqual(env());
	});

	test('a payload without env is left alone', () => {
		const d = { Id: own, Config: { Env: null } };
		maskOwnContainerEnv(d, own, false);
		expect(d.Config.Env).toBeNull();
		expect(() => maskOwnContainerEnv({ Id: own }, own, false)).not.toThrow();
	});
});

// The compose view of Dockhand's own container for a non-admin: both sides masked, so keys the
// image sets drop out on the key alone and no value is compared or shown.
describe('masked env with inspectToCompose', () => {
	test('inherited keys go, keys the image does not set stay, values hidden', () => {
		const rawEnv = ['PUID=1000', 'PATH=/usr/bin', 'DATABASE_URL=postgres://u:secret@db/x', 'MY_FLAG=1'];
		const view = (guess: string) =>
			inspectToCompose(
				{ Name: '/dockhand', Config: { Image: 'fnsys/dockhand', Env: maskEnvValues(rawEnv) } } as never,
				{ serviceName: 'dockhand', imageEnv: maskEnvValues(['PUID=1001', 'PATH=/usr/bin', `DATABASE_URL=postgres://u:${guess}@db/x`]) }
			);
		const env = ((yaml.load(view('guess')) as any)?.services?.dockhand?.environment as string[]) ?? [];
		expect(env).toEqual(['MY_FLAG=***']);
		expect(view('guess')).not.toContain('secret');
		// A right or a wrong guess in a retagged image gives the same answer.
		expect(view('secret')).toBe(view('guess'));
	});
});
