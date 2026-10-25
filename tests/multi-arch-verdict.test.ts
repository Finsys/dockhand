/**
 * The multi-arch update verdict: a per-arch pin or a republished index is the same image,
 * a real move is an update, and a registry that cannot be read is unknown (an error).
 * `index(AMD64)` is the real ghcr.io linuxserver/socket-proxy:3.4.7-r0-ls103 index
 * (children and attestations as published); NEW_AMD64 and OLD_INDEX are placeholders.
 */
import { describe, test, expect } from 'bun:test';
import { multiArchVerdict, readWithRetry, cachedIndexReader, type IndexRead } from '../src/lib/server/scheduler/tasks/update-utils';

const AMD64 = 'sha256:ac29ca26fbb6f06e9dbd2e00c42a8b70bfaadfe9734192f2cfc69815c22b361a';
const ARM64 = 'sha256:75fe933f6d93eb5c9b291a1b19f0c9d3352e33ba8f03fb87bc3fa1cff241ab12';
const NEW_AMD64 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const OLD_INDEX = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

const index = (amd64: string, arm64 = ARM64) => ({
	mediaType: 'application/vnd.oci.image.index.v1+json',
	manifests: [
		{ digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
		{ digest: 'sha256:4902b4155f56f3a25f15466ec34ce26647238c438dd0f4009c7eacf6fb005fcf', platform: { os: 'unknown', architecture: 'unknown' } },
		{ digest: arm64, platform: { os: 'linux', architecture: 'arm64' } },
		{ digest: 'sha256:fa11d38dd19d4ce3b860af542ae831e28dde36ec8230df1069cff009c57b1c32', platform: { os: 'unknown', architecture: 'unknown' } }
	]
});
const ok = (body: unknown): IndexRead => ({ ok: true, body });
const fail = (reason: string, retryable = true): IndexRead => ({ ok: false, reason, retryable });
const amd64 = async () => ({ os: 'linux', architecture: 'amd64' });

function reader(answers: Record<string, IndexRead>) {
	const calls: string[] = [];
	return {
		calls,
		readIndex: async (ref: string) => {
			calls.push(ref);
			return answers[ref] ?? fail(`unexpected read ${ref}`, false);
		}
	};
}

describe('multiArchVerdict', () => {
	test('a pin on the per-arch child of the current index is up to date', async () => {
		const r = reader({ '3.4.7-r0-ls103': ok(index(AMD64)) });
		const v = await multiArchVerdict({ tag: '3.4.7-r0-ls103', localDigests: [AMD64], readIndex: r.readIndex, platform: amd64 });
		expect(v).toEqual({ kind: 'same' });
	});

	test('a failed read of the current index is unknown, not an update', async () => {
		const r = reader({ tag: fail('Registry did not answer in time: ghcr.io') });
		const v = await multiArchVerdict({ tag: 'tag', localDigests: [AMD64], readIndex: r.readIndex, platform: amd64 });
		expect(v).toEqual({ kind: 'unknown', reason: 'Registry did not answer in time: ghcr.io' });
	});

	test('no index for the tag (single-arch, 404 under index-only Accept) is a real update', async () => {
		const r = reader({ tag: ok(null) });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [AMD64], readIndex: r.readIndex, platform: amd64 })).toEqual({ kind: 'different' });
	});

	test('a body that is not an index is a real update', async () => {
		const r = reader({ tag: ok({ mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [] }) });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: amd64 })).toEqual({ kind: 'different' });
	});

	test('an old index with the same image for this platform is up to date', async () => {
		const r = reader({ tag: ok(index(AMD64, NEW_AMD64)), [OLD_INDEX]: ok(index(AMD64)) });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: amd64 })).toEqual({ kind: 'same' });
	});

	test('an old index whose image for this platform moved is a real update', async () => {
		const r = reader({ tag: ok(index(NEW_AMD64)), [OLD_INDEX]: ok(index(AMD64)) });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: amd64 })).toEqual({ kind: 'different' });
	});

	test('the platform decides: an arm64 daemon ignores a moved amd64 entry', async () => {
		const r = reader({ tag: ok(index(NEW_AMD64)), [OLD_INDEX]: ok(index(AMD64)) });
		const arm64 = async () => ({ os: 'linux', architecture: 'arm64' });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: arm64 })).toEqual({ kind: 'same' });
	});

	test('an unreadable local index with no other match is unknown', async () => {
		const r = reader({ tag: ok(index(NEW_AMD64)), [OLD_INDEX]: fail('Registry server error (502)') });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: amd64 }))
			.toEqual({ kind: 'unknown', reason: 'Registry server error (502)' });
	});

	test('one unreadable local index does not hide a match on another', async () => {
		const other = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
		const r = reader({ tag: ok(index(AMD64, NEW_AMD64)), [other]: fail('Registry server error (502)'), [OLD_INDEX]: ok(index(AMD64)) });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [other, OLD_INDEX], readIndex: r.readIndex, platform: amd64 })).toEqual({ kind: 'same' });
	});

	test('a local digest that is not an index (404) is no match, not a failure', async () => {
		const r = reader({ tag: ok(index(NEW_AMD64)), [AMD64]: ok(null) });
		expect(await multiArchVerdict({ tag: 'tag', localDigests: [AMD64], readIndex: r.readIndex, platform: amd64 })).toEqual({ kind: 'different' });
	});

	test('an unknown daemon platform is unknown', async () => {
		const r = reader({ tag: ok(index(NEW_AMD64)) });
		const v = await multiArchVerdict({ tag: 'tag', localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: async () => null });
		expect(v.kind).toBe('unknown');
	});

	test('the child match needs no platform and no further reads', async () => {
		const r = reader({ tag: ok(index(AMD64)) });
		let asked = false;
		await multiArchVerdict({ tag: 'tag', localDigests: [AMD64], readIndex: r.readIndex, platform: async () => { asked = true; return null; } });
		expect(r.calls).toEqual(['tag']);
		expect(asked).toBe(false);
	});
});

describe('readWithRetry', () => {
	const scripted = (...answers: IndexRead[]) => {
		let i = 0;
		return { read: async () => answers[Math.min(i++, answers.length - 1)], count: () => i };
	};

	test('a transient failure is read again once, after the delay has elapsed', async () => {
		const events: string[] = [];
		const answers = [fail('Registry did not answer in time: ghcr.io'), ok(index(AMD64))];
		let i = 0;
		const read = async () => { events.push('read'); return answers[i++]; };
		const sleep = (ms: number) => new Promise<void>((resolve) => {
			events.push(`sleep ${ms}`);
			setTimeout(() => { events.push('woke'); resolve(); }, 0);
		});
		expect(await readWithRetry(read, sleep)).toEqual(ok(index(AMD64)));
		expect(events).toEqual(['read', 'sleep 2000', 'woke', 'read']);
	});

	test('a non-transient failure (401) is not retried', async () => {
		const s = scripted(fail('Registry denied access (401)', false), ok(index(AMD64)));
		const r = await readWithRetry(s.read, async () => {});
		expect(r.ok).toBe(false);
		expect(s.count()).toBe(1);
	});

	test('a success is not retried', async () => {
		const s = scripted(ok(null));
		const slept: number[] = [];
		await readWithRetry(s.read, async (ms) => { slept.push(ms); });
		expect(s.count()).toBe(1);
		expect(slept).toEqual([]);
	});

	test('two transient failures return the second', async () => {
		const s = scripted(fail('first'), fail('second'));
		expect(await readWithRetry(s.read, async () => {})).toEqual(fail('second'));
		expect(s.count()).toBe(2);
	});
});

describe('reading the current index by the digest the tag resolved to', () => {
	test('the index is read by that digest, not by the tag', async () => {
		const NEW_INDEX = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
		const r = reader({ [NEW_INDEX]: ok(index(NEW_AMD64)), [OLD_INDEX]: ok(index(AMD64)) });
		const v = await multiArchVerdict({ tag: 'tag', currentDigest: NEW_INDEX, localDigests: [OLD_INDEX], readIndex: r.readIndex, platform: amd64 });
		expect(v).toEqual({ kind: 'different' });
		expect(r.calls).toEqual([NEW_INDEX, OLD_INDEX]);
	});
});

describe('cachedIndexReader', () => {
	// A manifest GET is what Docker Hub counts as a pull; an index read by digest never
	// changes, so a check repeated while an update waits must not repeat it.
	const counting = (answer: (ref: string) => IndexRead) => {
		const calls: string[] = [];
		return { calls, read: async (ref: string) => { calls.push(ref); return answer(ref); } };
	};

	test('a read by digest is made once', async () => {
		const c = counting(() => ok(index(AMD64)));
		const read = cachedIndexReader(c.read, new Map(), 'ghcr.io/a/b');
		expect(await read(OLD_INDEX)).toEqual(ok(index(AMD64)));
		expect(await read(OLD_INDEX)).toEqual(ok(index(AMD64)));
		expect(c.calls).toEqual([OLD_INDEX]);
	});

	test('a read by tag is always made, since a tag moves', async () => {
		const c = counting(() => ok(index(AMD64)));
		const read = cachedIndexReader(c.read, new Map(), 'ghcr.io/a/b');
		await read('latest');
		await read('latest');
		expect(c.calls).toEqual(['latest', 'latest']);
	});

	test('a failed read is not kept', async () => {
		const failing = counting(() => fail('429'));
		const readFail = cachedIndexReader(failing.read, new Map(), 'x');
		await readFail(OLD_INDEX);
		await readFail(OLD_INDEX);
		expect(failing.calls.length).toBe(2);
	});

	test('a digest that names no index (404) is kept too, since that never changes either', async () => {
		const empty = counting(() => ok(null));
		const readEmpty = cachedIndexReader(empty.read, new Map(), 'x');
		expect(await readEmpty(OLD_INDEX)).toEqual(ok(null));
		expect(await readEmpty(OLD_INDEX)).toEqual(ok(null));
		expect(empty.calls.length).toBe(1);
	});

	test('the same digest in another repository is read on its own', async () => {
		const c = counting(() => ok(index(AMD64)));
		const cache = new Map();
		await cachedIndexReader(c.read, cache, 'ghcr.io/a/b')(OLD_INDEX);
		await cachedIndexReader(c.read, cache, 'docker.io/c/d')(OLD_INDEX);
		expect(c.calls.length).toBe(2);
	});

	test('the cache is bounded, dropping the oldest entry', async () => {
		const c = counting(() => ok(index(AMD64)));
		const cache = new Map();
		const read = cachedIndexReader(c.read, cache, 'r', 2);
		await read(OLD_INDEX);
		await read(NEW_AMD64);
		await read(AMD64);
		expect(cache.size).toBe(2);
		await read(OLD_INDEX);
		expect(c.calls).toEqual([OLD_INDEX, NEW_AMD64, AMD64, OLD_INDEX]);
	});
});
