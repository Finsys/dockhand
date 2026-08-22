import { describe, test, expect } from 'bun:test';
import { resolvePodmanUsernsMode } from '../src/lib/server/hostconfig-recreate';

// Podman lowers `--userns keep-id` to UsernsMode:"private" in inspect, which `create` then
// rejects without inline mappings (#1409). We restore the real intent from the
// io.podman.annotations.userns annotation. Guard is `=== 'private'` only, so Docker
// (which never reports a bare "private" - it doesn't even accept `--userns private`) is
// never touched. Verified live on Podman 5.4.2 and Docker 29.4.
const ANN = 'io.podman.annotations.userns';

describe('resolvePodmanUsernsMode', () => {
	test('keep-id: private + annotation -> restore keep-id', () => {
		expect(resolvePodmanUsernsMode('private', { [ANN]: 'keep-id' })).toEqual({ mode: 'keep-id' });
	});

	test('parameterised keep-id round-trips verbatim', () => {
		expect(resolvePodmanUsernsMode('private', { [ANN]: 'keep-id:uid=1000,gid=1000' }))
			.toEqual({ mode: 'keep-id:uid=1000,gid=1000' });
	});

	test('auto / nomap intents round-trip', () => {
		expect(resolvePodmanUsernsMode('private', { [ANN]: 'auto' })).toEqual({ mode: 'auto' });
		expect(resolvePodmanUsernsMode('private', { [ANN]: 'nomap' })).toEqual({ mode: 'nomap' });
	});

	test('private with NO recorded intent -> strip (safe: create picks a default instead of erroring)', () => {
		expect(resolvePodmanUsernsMode('private', {})).toEqual({ strip: true });
		expect(resolvePodmanUsernsMode('private', undefined)).toEqual({ strip: true });
		expect(resolvePodmanUsernsMode('private', { other: 'x' })).toEqual({ strip: true });
	});

	test('a blank/whitespace annotation is treated as absent -> strip', () => {
		expect(resolvePodmanUsernsMode('private', { [ANN]: '   ' })).toEqual({ strip: true });
	});

	// Docker regression guard: only the literal lowered "private" is ever changed.
	test('Docker / non-private modes are left untouched (null)', () => {
		expect(resolvePodmanUsernsMode('', { [ANN]: 'keep-id' })).toBeNull();
		expect(resolvePodmanUsernsMode('host', undefined)).toBeNull();
		expect(resolvePodmanUsernsMode('container:abc', undefined)).toBeNull();
		expect(resolvePodmanUsernsMode('keep-id', undefined)).toBeNull(); // already correct - don't re-touch
		expect(resolvePodmanUsernsMode(undefined, undefined)).toBeNull();
		expect(resolvePodmanUsernsMode(null, undefined)).toBeNull();
	});
});
