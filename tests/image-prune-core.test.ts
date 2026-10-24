// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { buildImagePruneFilters, buildKeepLabelFilter, labelNegationBroken, imageRefsToRemove, pruneAllUnused, PRUNE_KEEP_LABEL, type PruneImageSummary } from '../src/lib/server/image-prune-core';

function decode(filters: string): Record<string, string[]> {
	return JSON.parse(decodeURIComponent(filters));
}

describe('buildImagePruneFilters', () => {
	test('dangling=true has no label filter (untagged images have no keep label)', () => {
		expect(decode(buildImagePruneFilters(true))).toEqual({ dangling: ['true'] });
	});

	test('dangling=false excludes keep-labelled images via the label! key', () => {
		// The negation MUST be the separate `label!` key, not a `!=` value prefix -
		// the API ignores the `!=` form (verified against a live daemon).
		expect(decode(buildImagePruneFilters(false))).toEqual({
			dangling: ['false'],
			'label!': ['dockhand.prune=false']
		});
	});

	test('does NOT use a plain "label" key (which would invert the meaning)', () => {
		const f = decode(buildImagePruneFilters(false));
		expect(f['label']).toBeUndefined();
		expect(f['label!']).toEqual([PRUNE_KEEP_LABEL]);
	});

	test('the produced value is URL-encoded', () => {
		expect(buildImagePruneFilters(false)).not.toContain('{');
		expect(buildImagePruneFilters(false)).toContain('%7B');
	});
});

describe('buildKeepLabelFilter', () => {
	test('lists images with the keep label, or with negate those without it', () => {
		expect(decode(buildKeepLabelFilter(false))).toEqual({ label: [PRUNE_KEEP_LABEL] });
		expect(decode(buildKeepLabelFilter(true))).toEqual({ 'label!': [PRUNE_KEEP_LABEL] });
	});
});

describe('labelNegationBroken', () => {
	// Docker 29.2.1 + containerd store, measured: 5 images, `label!` lists 0 of them.
	test('images exist but none is listed without the keep label', () => {
		expect(labelNegationBroken(5, 0)).toBe(true);
	});

	test('a working filter, or no images at all, is not broken', () => {
		expect(labelNegationBroken(5, 4)).toBe(false);
		expect(labelNegationBroken(5, 5)).toBe(false);
		expect(labelNegationBroken(0, 0)).toBe(false);
	});
});

describe('imageRefsToRemove', () => {
	const images = [
		{ Id: 'sha256:used', RepoTags: ['busybox:1.36'] },
		{ Id: 'sha256:kept', RepoTags: ['keep:1'] },
		{ Id: 'sha256:multi', RepoTags: ['alpine:3.20', 'multi:x'] },
		{ Id: 'sha256:one', RepoTags: ['hello-world:latest'] },
		{ Id: 'sha256:dangling', RepoTags: ['<none>:<none>'] },
		{ Id: 'sha256:untagged', RepoTags: null }
	];

	test('skips what a container uses and what carries the keep label', () => {
		const refs = imageRefsToRemove(images, new Set(['sha256:kept']), new Set(['sha256:used']));
		expect(refs).toEqual([['alpine:3.20', 'multi:x'], ['hello-world:latest'], ['sha256:dangling'], ['sha256:untagged']]);
	});

	test('an image used and labelled is kept once, and with nothing protected everything goes', () => {
		expect(imageRefsToRemove(images.slice(0, 1), new Set(['sha256:used']), new Set(['sha256:used']))).toEqual([]);
		expect(imageRefsToRemove(images.slice(0, 2), new Set(), new Set())).toEqual([['busybox:1.36'], ['keep:1']]);
	});
});

describe('pruneAllUnused', () => {
	// The engine as measured on Docker 29.2.1 (containerd): `label!` lists nothing, the
	// positive `label` filter works, DELETE of a tag answers with what it untagged and
	// 409s the last tag of an image a container uses.
	function engine(images: (PruneImageSummary & { label?: boolean })[], used: string[], broken: boolean) {
		const calls: string[] = [];
		const removed: string[] = [];
		const ports = {
			listImages: async (filters?: string) => {
				calls.push(`list ${filters ? Object.keys(decode(filters))[0] : 'all'}`);
				if (!filters) return images;
				const f = decode(filters);
				if (f['label!']) return broken ? [] : images.filter((i) => !i.label);
				return images.filter((i) => i.label);
			},
			listContainers: async () => used.map((ImageID) => ({ ImageID })),
			prune: async () => { calls.push('prune'); return { ImagesDeleted: [{ Deleted: 'sha256:x' }], SpaceReclaimed: 42 }; },
			remove: async (ref: string) => {
				calls.push(`delete ${ref}`);
				const img = images.find((i) => i.Id === ref || i.RepoTags?.includes(ref))!;
				const tagsLeft = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>' && !removed.includes(t));
				if (used.includes(img.Id) && tagsLeft.length <= 1) throw Object.assign(new Error('conflict: image is being used'), { statusCode: 409 });
				if (img.RepoTags?.includes(ref)) removed.push(ref);
				return tagsLeft.length > 1 ? [{ Untagged: ref }] : [{ Untagged: ref }, { Deleted: img.Id }];
			},
			log: () => {}
		};
		return { ports, calls };
	}
	const images = [
		{ Id: 'sha256:busybox', RepoTags: ['busybox:1.36'] },
		{ Id: 'sha256:keep', RepoTags: ['keep:1'], label: true },
		{ Id: 'sha256:alpine', RepoTags: ['alpine:3.20', 'multi:x'] },
		{ Id: 'sha256:hello', RepoTags: ['hello-world:latest'] }
	];

	test('a working engine gets one ordinary prune, its result untouched', async () => {
		const { ports, calls } = engine(images, ['sha256:busybox'], false);
		expect(await pruneAllUnused(ports)).toEqual({ ImagesDeleted: [{ Deleted: 'sha256:x' }], SpaceReclaimed: 42 });
		expect(calls).toEqual(['list all', 'list label!', 'prune']);
	});

	test('a broken engine removes the unused, unlabelled images one by one and reports no space', async () => {
		const { ports, calls } = engine(images, ['sha256:busybox'], true);
		const result = await pruneAllUnused(ports);
		expect(calls.filter((c) => c.startsWith('delete') || c === 'prune')).toEqual(['delete alpine:3.20', 'delete multi:x', 'delete hello-world:latest']);
		expect(result).toEqual({
			ImagesDeleted: [{ Untagged: 'alpine:3.20' }, { Untagged: 'multi:x' }, { Deleted: 'sha256:alpine' }, { Untagged: 'hello-world:latest' }, { Deleted: 'sha256:hello' }]
		});
		expect('SpaceReclaimed' in result).toBe(false);
	});

	test('a refusal keeps that image and the loop carries on with the next', async () => {
		// `two` comes into use after the listing: the engine untags one tag and refuses the last.
		const { ports, calls } = engine([images[0], { Id: 'sha256:two', RepoTags: ['two:a', 'two:b'] }, images[3]], ['sha256:two'], true);
		ports.listContainers = async () => [];
		const result = await pruneAllUnused(ports);
		expect(calls.filter((c) => c.startsWith('delete'))).toEqual(['delete busybox:1.36', 'delete two:a', 'delete two:b', 'delete hello-world:latest']);
		expect(result.ImagesDeleted).toContainEqual({ Deleted: 'sha256:hello' });
		expect(result.ImagesDeleted).not.toContainEqual({ Deleted: 'sha256:two' });
	});

	test('once the engine refuses a tag, the image keeps its other tags', async () => {
		const { ports, calls } = engine([{ Id: 'sha256:two', RepoTags: ['two:a', 'two:b'] }, images[3]], [], true);
		const remove = ports.remove;
		ports.remove = async (ref) => { if (ref === 'two:a') throw new Error('conflict'); return remove(ref); };
		await pruneAllUnused(ports);
		expect(calls.filter((c) => c.startsWith('delete'))).toEqual(['delete hello-world:latest']);
	});

	test('nothing to remove is reported as no images, like an empty prune', async () => {
		const { ports } = engine([images[1]], [], true);
		expect(await pruneAllUnused(ports)).toEqual({ ImagesDeleted: null });
	});
});
