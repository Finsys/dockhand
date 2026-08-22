/**
 * Unit tests for rebaseEnvOntoImage / rebaseLabelsOntoImage (#1226, #1256).
 *
 * The rebase adopts the NEW image's defaults for keys the user never
 * touched (container value == old image value), while preserving user
 * overrides (value differs) and user-only entries. This is the #1135
 * merge corrected from key-membership to value-equality, so the #1135
 * contract (user overrides survive) must still hold here.
 */

import { describe, test, expect } from 'bun:test';
import {
	rebaseEnvOntoImage,
	rebaseLabelsOntoImage,
	rebaseCommand,
	describeEnvRebase,
	describeLabelRebase
} from '../src/lib/server/container-env-merge';

// Small helpers for order-independent assertions.
const envMap = (arr: string[]) => {
	const m: Record<string, string> = {};
	for (const e of arr) {
		const i = e.indexOf('=');
		m[i === -1 ? e : e.slice(0, i)] = i === -1 ? '\0INHERIT' : e.slice(i + 1);
	}
	return m;
};
const val = (arr: string[], key: string) => envMap(arr)[key];
const has = (arr: string[], key: string) => key in envMap(arr);

describe('rebaseEnvOntoImage', () => {
	test('idempotent when all three are equal', () => {
		const eq = ['PATH=/usr/bin', 'A=1'];
		expect(rebaseEnvOntoImage(eq, eq, eq).sort()).toEqual(eq.slice().sort());
	});

	test('new image adds a var (user never had it) -> adopted (#1226)', () => {
		const out = rebaseEnvOntoImage(['A=1'], ['A=1'], ['A=1', 'NEW=2']);
		expect(val(out, 'NEW')).toBe('2');
		expect(val(out, 'A')).toBe('1');
	});

	test('new image changes an untouched baked var -> adopted (#1226 core)', () => {
		// Container has the OLD baked value; user never overrode it.
		const out = rebaseEnvOntoImage(
			['APP_VERSION=1.5.2', 'PATH=/usr/bin'],
			['APP_VERSION=1.5.2', 'PATH=/usr/bin'],
			['APP_VERSION=1.6.2', 'PATH=/usr/bin']
		);
		expect(val(out, 'APP_VERSION')).toBe('1.6.2');
	});

	test('user override of a baked key (value differs) -> preserved (#1135)', () => {
		const out = rebaseEnvOntoImage(
			['NGINX_VERSION=user-override'],
			['NGINX_VERSION=1.27.3'],
			['NGINX_VERSION=1.27.4']
		);
		expect(val(out, 'NGINX_VERSION')).toBe('user-override');
	});

	test('user-only var (absent from both images) -> preserved', () => {
		const out = rebaseEnvOntoImage(['MY_CUSTOM=keep'], ['A=1'], ['A=1']);
		expect(val(out, 'MY_CUSTOM')).toBe('keep');
	});

	test('key removed by new image, user never set it -> dropped', () => {
		const out = rebaseEnvOntoImage(['GONE=old', 'A=1'], ['GONE=old', 'A=1'], ['A=1']);
		expect(has(out, 'GONE')).toBe(false);
		expect(val(out, 'A')).toBe('1');
	});

	test('key removed by new image but user-overrode it -> kept', () => {
		const out = rebaseEnvOntoImage(['GONE=mine'], ['GONE=orig'], ['A=1']);
		expect(val(out, 'GONE')).toBe('mine');
		expect(val(out, 'A')).toBe('1');
	});

	test('#1226 + #1135 together: untouched adopts, overridden survives', () => {
		const out = rebaseEnvOntoImage(
			['APP_VERSION=1', 'PORT=custom', 'USER_ONLY=x'],
			['APP_VERSION=1', 'PORT=8080'],
			['APP_VERSION=2', 'PORT=8080']
		);
		expect(val(out, 'APP_VERSION')).toBe('2'); // untouched -> new default
		expect(val(out, 'PORT')).toBe('custom'); // overridden -> kept
		expect(val(out, 'USER_ONLY')).toBe('x'); // user-only -> kept
	});

	test('empty inputs', () => {
		expect(rebaseEnvOntoImage([], [], [])).toEqual([]);
		expect(rebaseEnvOntoImage(['A=1'], [], []).sort()).toEqual(['A=1']);
		expect(rebaseEnvOntoImage([], [], ['A=1'])).toEqual(['A=1']);
	});

	test('oldImage empty -> every container entry treated as user layer (verbatim-ish)', () => {
		// No old image to compare against: user values must all survive.
		const out = rebaseEnvOntoImage(['A=mine', 'B=keep'], [], ['A=new']);
		expect(val(out, 'A')).toBe('mine');
		expect(val(out, 'B')).toBe('keep');
	});

	test('FALLBACK: empty old image preserves ALL container values verbatim (backward compat)', () => {
		// This is the backward-compat guarantee: when the old image cannot be
		// inspected (oldImageConfig null -> Env []), the recreate code calls the
		// rebase with oldImageEnv=[]. Every container value — including image-baked
		// keys — must survive unchanged, matching pre-rebase behavior. The new
		// image's ADDED keys may appear, but no existing container value is altered.
		const containerEnv = ['VERSION_LABEL=1', 'DB_PASSWORD=secret', 'PATH=/usr/bin'];
		const out = rebaseEnvOntoImage(containerEnv, [], ['VERSION_LABEL=2', 'PATH=/usr/bin']);
		expect(val(out, 'VERSION_LABEL')).toBe('1'); // NOT bumped — no old image to compare
		expect(val(out, 'DB_PASSWORD')).toBe('secret'); // untouched
		expect(val(out, 'PATH')).toBe('/usr/bin');
		// Every original container key is still present with its original value.
		for (const e of containerEnv) expect(out).toContain(e);
	});

	test('value containing = splits on first =', () => {
		const out = rebaseEnvOntoImage(
			['CONFIG=a=b=c'],
			['CONFIG=a=b=c'],
			['CONFIG=x=y=z']
		);
		expect(val(out, 'CONFIG')).toBe('x=y=z'); // untouched -> adopts new
	});

	test('empty value KEY= vs changed', () => {
		expect(val(rebaseEnvOntoImage(['E='], ['E='], ['E=set']), 'E')).toBe('set'); // untouched
		expect(val(rebaseEnvOntoImage(['E=mine'], ['E='], ['E=set']), 'E')).toBe('mine'); // override
	});

	test('bare KEY (inherit-from-daemon) round-trips and is distinct from KEY=', () => {
		// Container inherits INHERIT_ME; old image also had it bare -> untouched.
		const out = rebaseEnvOntoImage(['INHERIT_ME'], ['INHERIT_ME'], ['INHERIT_ME']);
		expect(out).toContain('INHERIT_ME');
		expect(out).not.toContain('INHERIT_ME=');
		// User sets a value where image had bare -> override survives.
		const out2 = rebaseEnvOntoImage(['INHERIT_ME=v'], ['INHERIT_ME'], ['INHERIT_ME']);
		expect(val(out2, 'INHERIT_ME')).toBe('v');
	});

	test('duplicate keys in container env -> last wins (Docker semantics)', () => {
		const out = rebaseEnvOntoImage(['A=1', 'A=2'], [], []);
		expect(val(out, 'A')).toBe('2');
		expect(out.filter(e => e.startsWith('A=')).length).toBe(1);
	});

	test('case sensitivity: Foo and FOO are distinct keys', () => {
		const out = rebaseEnvOntoImage(['Foo=a', 'FOO=b'], ['Foo=a', 'FOO=b'], ['Foo=x', 'FOO=y']);
		expect(val(out, 'Foo')).toBe('x');
		expect(val(out, 'FOO')).toBe('y');
	});
});

describe('rebaseLabelsOntoImage', () => {
	test('untouched OCI version label adopts new image value (#1256)', () => {
		const out = rebaseLabelsOntoImage(
			{ 'org.opencontainers.image.version': '1' },
			{ 'org.opencontainers.image.version': '1' },
			{ 'org.opencontainers.image.version': '2' }
		);
		expect(out['org.opencontainers.image.version']).toBe('2');
	});

	test('user-overridden label (value differs) -> preserved (#1135 label half)', () => {
		const out = rebaseLabelsOntoImage(
			{ 'com.test.policy': 'strict' },
			{},
			{ 'com.test.policy': 'lax' }
		);
		expect(out['com.test.policy']).toBe('strict');
	});

	test('protected compose/dockhand labels never dropped even if image bakes them', () => {
		const out = rebaseLabelsOntoImage(
			{ 'com.docker.compose.project': 'mystack', 'dockhand.managed': 'true' },
			{},
			{ 'com.docker.compose.project': 'image-baked', 'dockhand.managed': 'false' }
		);
		expect(out['com.docker.compose.project']).toBe('mystack');
		expect(out['dockhand.managed']).toBe('true');
	});

	test('null/undefined inputs', () => {
		expect(rebaseLabelsOntoImage(null, null, null)).toEqual({});
		expect(rebaseLabelsOntoImage({ A: '1' }, null, null)).toEqual({ A: '1' });
		expect(rebaseLabelsOntoImage(null, null, { A: '1' })).toEqual({ A: '1' });
	});

	test('label removed by new image, user untouched -> dropped', () => {
		const out = rebaseLabelsOntoImage({ maintainer: 'x' }, { maintainer: 'x' }, {});
		expect('maintainer' in out).toBe(false);
	});
});

describe('describeEnvRebase', () => {
	test('classifies adopted / preserved / userOnly', () => {
		const s = describeEnvRebase(
			['APP_VERSION=1', 'PORT=custom', 'USER_ONLY=x'],
			['APP_VERSION=1', 'PORT=8080'],
			['APP_VERSION=2', 'PORT=8080', 'NEW_DEFAULT=9']
		);
		expect(s.adopted.sort()).toEqual(['APP_VERSION', 'NEW_DEFAULT']); // untouched bumped + brand new
		expect(s.preserved).toEqual(['PORT']); // user override of a baked key
		expect(s.userOnly).toEqual(['USER_ONLY']); // not in either image
	});

	test('no changes when everything matches', () => {
		const s = describeEnvRebase(['A=1'], ['A=1'], ['A=1']);
		expect(s.adopted).toEqual([]);
		expect(s.preserved).toEqual([]);
		expect(s.userOnly).toEqual([]);
	});
});

describe('describeLabelRebase', () => {
	test('OCI version adopted, user label preserved, protected label preserved', () => {
		const s = describeLabelRebase(
			{
				'org.opencontainers.image.version': '1',
				'com.test.policy': 'strict',
				'com.docker.compose.project': 'mystack'
			},
			{ 'org.opencontainers.image.version': '1' },
			{ 'org.opencontainers.image.version': '2' }
		);
		expect(s.adopted).toEqual(['org.opencontainers.image.version']);
		// Neither compose nor user label is in the image => both classified user-only.
		expect(s.userOnly).toContain('com.docker.compose.project');
		expect(s.userOnly).toContain('com.test.policy');
	});
});

describe('rebaseCommand — Cmd/Entrypoint rebase (#1371)', () => {
	// The real-world case from #1371: image restructured, dropped the entrypoint script.
	const OLD_CMD = ['/bin/sh', '-c', './scripts/inject-vars.sh && node ./dist/index.js'];
	const NEW_CMD = ['node', 'dist/index.js'];

	test('image-baked command the user never overrode -> ADOPTS the new image (the bug)', () => {
		// container.Cmd == oldImage.Cmd (came from the image) and the new image changed it.
		const r = rebaseCommand(OLD_CMD, OLD_CMD, NEW_CMD);
		expect(r.value).toEqual(NEW_CMD);
		expect(r.adopted).toBe(true);
	});

	test('a genuine user/Compose override (differs from old image) is KEPT', () => {
		const userCmd = ['node', '--inspect', 'dist/index.js'];
		const r = rebaseCommand(userCmd, OLD_CMD, NEW_CMD);
		expect(r.value).toEqual(userCmd);
		expect(r.adopted).toBe(false);
	});

	test('old image value unknown (null) -> keep container verbatim (fallback)', () => {
		const r = rebaseCommand(OLD_CMD, null, NEW_CMD);
		expect(r.value).toEqual(OLD_CMD);
		expect(r.adopted).toBe(false);
	});
	test('old image value unknown (undefined) -> keep container verbatim', () => {
		const r = rebaseCommand(OLD_CMD, undefined, NEW_CMD);
		expect(r.value).toEqual(OLD_CMD);
		expect(r.adopted).toBe(false);
	});

	test('image did not change the command -> no-op (keep, not adopted)', () => {
		const r = rebaseCommand(OLD_CMD, OLD_CMD, OLD_CMD);
		expect(r.value).toEqual(OLD_CMD);
		expect(r.adopted).toBe(false);
	});

	test('null Entrypoint on both sides is stable', () => {
		const r = rebaseCommand(null, null, null);
		expect(r.value).toEqual(null);
		expect(r.adopted).toBe(false);
	});

	test('old value null is treated as UNKNOWN -> keep verbatim (never adopt), even if new image adds one', () => {
		// A null old Entrypoint is ambiguous ("image has none" vs "couldn't inspect"), so we
		// fall back to verbatim rather than risk adopting onto a wrongly-assumed baseline.
		const r = rebaseCommand(null, null, ['/entry.sh']);
		expect(r.value).toEqual(null);
		expect(r.adopted).toBe(false);
	});

	test('order matters: same elements, different order = a user override, kept', () => {
		const reordered = ['dist/index.js', 'node'];
		const r = rebaseCommand(reordered, NEW_CMD, ['node', 'dist/other.js']);
		expect(r.value).toEqual(reordered);
		expect(r.adopted).toBe(false);
	});
});
