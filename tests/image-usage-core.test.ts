// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { containerImageResolver, containerImageNamer, containersPerImage, displayTag, needsManifestLookup } from '../src/lib/server/image-usage-core';

// Shapes as measured on Docker 29.8 with the containerd image store: after a rebuild from
// cache the tag holds a new index ID, the container that was not recreated keeps the old ID
// (gone from the image list), and only the platform manifest digest still matches. One
// Dockerfile built under two tags gives two image IDs holding the same platform manifest.
const oldIndex = 'sha256:22bdafb21fc82bf2273f5007fd5ff4d74dfdb6bba50ff52bbbd4d22ef5f5482b';
const newIndex = 'sha256:82daa0fbeefda982e03c478cab91a92004488543e5d684292e79c636dc86f64a';
const twinIndex = 'sha256:' + 'c'.repeat(64);
const platform = 'sha256:b805d8dc77b4f2643169d3a6fa395229de97853d3dac0857e7d555ece5521a0b';
const attestation = 'sha256:28f2106956f7b2f0de4ffed69dd050c937f60284f0cffe3f7bc093a85686b6d1';

const rebuilt = { Id: newIndex, RepoTags: ['worker-card:latest'], Created: 200, Manifests: [{ ID: platform }, { ID: attestation }] };
const twin = { Id: twinIndex, RepoTags: ['other-project-card:latest'], Created: 100, Manifests: [{ ID: platform }] };
const other = { Id: 'sha256:' + 'e'.repeat(64), RepoTags: ['<none>:<none>'], Manifests: [{ ID: 'sha256:' + 'f'.repeat(64) }] };
const plain = [{ Id: newIndex, RepoTags: ['worker-card:latest'] }];
const stale = { ImageID: oldIndex, ImageManifestDescriptor: { digest: platform } };
const matched = { ImageID: newIndex, ImageManifestDescriptor: { digest: platform } };

describe('containerImageResolver', () => {
	test('a container on a vanished index ID resolves to the image holding its platform manifest', () => {
		expect(containerImageResolver([other, rebuilt])(stale)).toEqual([rebuilt]);
	});

	test('every image holding the manifest is returned, in either list order', () => {
		expect(containerImageResolver([rebuilt, twin])(stale)).toEqual([rebuilt, twin]);
		expect(containerImageResolver([twin, rebuilt])(stale)).toEqual([twin, rebuilt]);
	});

	test('an exact image ID wins over the manifest', () => {
		const exact = { Id: oldIndex, RepoTags: [], Manifests: [] };
		expect(containerImageResolver([rebuilt, exact])(stale)).toEqual([exact]);
	});

	test('no match without a descriptor, as on the classic store or an older API', () => {
		const imagesOf = containerImageResolver([rebuilt]);
		expect(imagesOf({ ImageID: oldIndex })).toEqual([]);
		expect(imagesOf({ ImageID: oldIndex, ImageManifestDescriptor: null })).toEqual([]);
	});

	test('a descriptor for a manifest no image holds matches nothing', () => {
		expect(containerImageResolver([rebuilt, other])({ ImageID: oldIndex, ImageManifestDescriptor: { digest: 'sha256:' + '9'.repeat(64) } })).toEqual([]);
	});

	test('images listed without manifests still match by ID', () => {
		const imagesOf = containerImageResolver(plain);
		expect(imagesOf({ ImageID: newIndex }).map((i) => i.Id)).toEqual([newIndex]);
		expect(imagesOf(stale)).toEqual([]);
	});
});

describe('needsManifestLookup', () => {
	test('only a container with a descriptor and a missing image ID needs it', () => {
		expect(needsManifestLookup(plain, [stale])).toBe(true);
		expect(needsManifestLookup(plain, [{ ImageManifestDescriptor: { digest: platform } }])).toBe(true);
		// One stale container among matched ones is enough.
		expect(needsManifestLookup(plain, [matched, stale, matched])).toBe(true);
	});

	test('classic store, older API and matched containers keep the plain list', () => {
		expect(needsManifestLookup(plain, [{ ImageID: oldIndex }])).toBe(false);
		expect(needsManifestLookup(plain, [{ ImageID: oldIndex, ImageManifestDescriptor: null }])).toBe(false);
		expect(needsManifestLookup(plain, [{ ImageID: oldIndex, ImageManifestDescriptor: {} }])).toBe(false);
		expect(needsManifestLookup(plain, [matched])).toBe(false);
		expect(needsManifestLookup(plain, [])).toBe(false);
	});
});

describe('containersPerImage', () => {
	const loader = (images: any[]) => {
		const calls: number[] = [];
		return { calls, load: async () => { calls.push(1); return images; } };
	};

	test('a stale container counts for every image holding its manifest', async () => {
		const { calls, load } = loader([rebuilt, twin, other]);
		const counts = await containersPerImage(plain, [stale, matched], load, true);
		expect(calls.length).toBe(1);
		expect(Object.fromEntries(counts)).toEqual({ [newIndex]: 2, [twinIndex]: 1 });
	});

	test('without a stale container the manifest list is never loaded, and counts match by ID', async () => {
		const { calls, load } = loader([rebuilt]);
		const counts = await containersPerImage(plain, [matched, { ImageID: newIndex }], load, true);
		expect(calls.length).toBe(0);
		expect(Object.fromEntries(counts)).toEqual({ [newIndex]: 2 });
	});

	test('a container matching no image counts under its own ID, then its Image', async () => {
		const counts = await containersPerImage(plain, [{ ImageID: oldIndex }, { Image: 'sha256:raw' } as any], async () => [], true);
		expect(Object.fromEntries(counts)).toEqual({ [oldIndex]: 1, 'sha256:raw': 1 });
	});

	test('strict rethrows a failed load; otherwise the plain list is used', async () => {
		const failing = async () => { throw new Error('daemon unreachable'); };
		await expect(containersPerImage(plain, [stale], failing, true)).rejects.toThrow('daemon unreachable');
		expect(Object.fromEntries(await containersPerImage(plain, [stale], failing, false))).toEqual({ [oldIndex]: 1 });
	});
});

describe('containerImageNamer', () => {
	type C = { ImageID?: string; ImageManifestDescriptor?: { digest?: string } | null; name: string };
	const nameOf = (c: C) => c.name;

	test('a bare ID gets the tag of the newest image holding the same content', async () => {
		const name = await containerImageNamer<C>([{ ...stale, name: oldIndex }], nameOf, async () => [twin, rebuilt]);
		expect(name({ ...stale, name: oldIndex })).toBe('worker-card:latest');
	});

	test('a container already shown by name is left alone and nothing is loaded', async () => {
		let loads = 0;
		const containers = [{ ...matched, name: 'worker-card:latest' }, { ...stale, name: 'app:1' }];
		const name = await containerImageNamer<C>(containers, nameOf, async () => { loads++; return [rebuilt]; });
		expect(loads).toBe(0);
		expect(containers.map(name)).toEqual(['worker-card:latest', 'app:1']);
	});

	test('next to a bare ID, a container shown by name keeps that name', async () => {
		const containers = [{ ...stale, name: oldIndex }, { ...stale, name: 'pinned-by-user:1' }];
		const name = await containerImageNamer<C>(containers, nameOf, async () => [rebuilt]);
		expect(containers.map(name)).toEqual(['worker-card:latest', 'pinned-by-user:1']);
	});

	test('a bare ID without a descriptor loads nothing and stays an ID', async () => {
		let loads = 0;
		const c = { ImageID: oldIndex, name: oldIndex };
		const name = await containerImageNamer<C>([c], nameOf, async () => { loads++; return [rebuilt]; });
		expect(loads).toBe(0);
		expect(name(c)).toBe(oldIndex);
	});

	test('an exact but untagged image keeps the ID, and a failed load keeps it too', async () => {
		const c = { ...stale, name: oldIndex };
		const exact = { Id: oldIndex, RepoTags: ['<none>:<none>'], Manifests: [{ ID: platform }] };
		expect((await containerImageNamer<C>([c], nameOf, async () => [exact, rebuilt]))(c)).toBe(oldIndex);
		expect((await containerImageNamer<C>([c], nameOf, async () => { throw new Error('down'); }))(c)).toBe(oldIndex);
	});
});

describe('displayTag', () => {
	test('the first real tag, never the untagged placeholder or an empty string', () => {
		expect(displayTag(rebuilt)).toBe('worker-card:latest');
		expect(displayTag(other)).toBeUndefined();
		expect(displayTag({ Id: 'x', RepoTags: ['<none>:<none>', '', 'app:1', 'app:2'] })).toBe('app:1');
		expect(displayTag({ Id: 'x', RepoTags: null })).toBeUndefined();
		expect(displayTag(undefined)).toBeUndefined();
	});
});
