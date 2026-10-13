import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fetchImageCreatedAt, imagePlatform, type ImageAgeRequest } from '../src/lib/server/registry/image-age';

const IMAGE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';
const CONFIG = 'application/vnd.oci.image.config.v1+json';
const created = '2024-01-01T00:00:00.000Z';
const digestOf = (body: string) => 'sha256:' + createHash('sha256').update(body).digest('hex');

function fixture(config: Record<string, unknown> = { created, os: 'linux', architecture: 'amd64' }) {
	const configBody = JSON.stringify(config);
	const configDigest = digestOf(configBody);
	const manifest = JSON.stringify({ schemaVersion: 2, mediaType: IMAGE, config: { digest: configDigest, mediaType: CONFIG } });
	const digest = digestOf(manifest);
	const documents = new Map([[digest, manifest], [configDigest, configBody]]);
	const calls: { url: string; init: RequestInit }[] = [];
	const request: ImageAgeRequest = {
		registry: 'registry.example.com', repo: 'team/app', digest,
		platform: { os: 'linux', architecture: 'amd64' }, scheme: 'https', authorization: 'Bearer test-token'
	};
	const fetcher = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const body = documents.get(url.split('/').pop()!);
		return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { headers: { 'Content-Type': IMAGE } });
	};
	return { request, documents, calls, fetcher, configDigest, manifest };
}

function addIndex(f: ReturnType<typeof fixture>, manifests: unknown[]) {
	const body = JSON.stringify({ schemaVersion: 2, mediaType: INDEX, manifests });
	f.request.digest = digestOf(body);
	f.documents.set(f.request.digest, body);
}

describe('generic registry image creation time', () => {
	test('reads the exact digest and config, without requesting tags or layers', async () => {
		const f = fixture();
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBe(created);
		expect(f.calls.map(call => new URL(call.url).pathname)).toEqual([
			`/v2/team/app/manifests/${f.request.digest}`, `/v2/team/app/blobs/${f.configDigest}`
		]);
		expect(f.calls.every(call => (call.init.headers as Record<string, string>).Authorization === 'Bearer test-token')).toBe(true);
		expect(f.calls.every(call => call.init.redirect === 'manual' && call.init.signal)).toBe(true);
	});

	test('uses the same API for Docker Hub, GHCR and private registries', async () => {
		for (const registry of ['index.docker.io', 'ghcr.io', 'gitea.example.com', '192.168.1.10:5000']) {
			const f = fixture();
			f.request.registry = registry;
			f.request.repo = 'team/app__build--test';
			f.request.scheme = 'http';
			expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBe(created);
			expect(f.calls.every(call => call.url.startsWith(`http://${registry}/v2/team/app__build--test/`))).toBe(true);
		}
	});

	test('selects the target platform and skips attestations', async () => {
		const f = fixture({ created, os: 'linux', architecture: 'arm64' });
		const childDigest = f.request.digest;
		f.request.platform = { os: 'linux', architecture: 'arm64' };
		addIndex(f, [
			{ digest: 'sha256:' + 'b'.repeat(64), platform: { os: 'linux', architecture: 'amd64' } },
			{ digest: 'sha256:' + 'c'.repeat(64), platform: f.request.platform, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
			{ digest: childDigest, platform: f.request.platform }
		]);
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBe(created);
		expect(f.calls[1].url).toEndWith(`/manifests/${childDigest}`);
		expect(f.calls).toHaveLength(3);
	});

	test('falls back for an unknown or ambiguous platform, and selects explicit ARM variants', async () => {
		const f = fixture({ created, os: 'linux', architecture: 'arm', variant: 'v7' });
		const child = f.request.digest;
		addIndex(f, [
			{ digest: child, platform: { os: 'linux', architecture: 'arm', variant: 'v7' } },
			{ digest: 'sha256:' + 'b'.repeat(64), platform: { os: 'linux', architecture: 'arm', variant: 'v6' } }
		]);
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
		f.request.platform = { os: 'linux', architecture: 'arm' };
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
		f.request.platform.variant = 'v7';
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBe(created);
	});

	test('falls back for a single-platform image targeting a different architecture', async () => {
		const f = fixture();
		f.request.platform.architecture = 'arm64';
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
	});

	test('supports Docker schema 2 manifests and media type from the response header', async () => {
		for (const mediaType of ['application/vnd.docker.distribution.manifest.v2+json', undefined]) {
			const f = fixture();
			const body = JSON.stringify({ schemaVersion: 2, mediaType, config: { digest: f.configDigest, mediaType: 'application/vnd.docker.container.image.v1+json' } });
			f.request.digest = digestOf(body);
			f.documents.set(f.request.digest, body);
			expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBe(created);
		}
	});

	test('rejects metadata for a different manifest or config digest', async () => {
		for (const which of ['manifest', 'config']) {
			const f = fixture();
			f.documents.set(which === 'manifest' ? f.request.digest : f.configDigest, '{}');
			expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
		}
	});

	test('rejects non-image config blobs', async () => {
		const f = fixture();
		const body = JSON.stringify({ schemaVersion: 2, mediaType: IMAGE, config: { digest: f.configDigest, mediaType: 'application/vnd.cncf.helm.config.v1+json' } });
		f.request.digest = digestOf(body);
		f.documents.set(f.request.digest, body);
		expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
		expect(f.calls).toHaveLength(1);
	});

	test('falls back for absent, invalid and future timestamps', async () => {
		for (const timestamp of [undefined, null, '', 'invalid', '2024-01-01', '2024-02-30T00:00:00Z', new Date(Date.now() + 86400000).toISOString()]) {
			const f = fixture({ created: timestamp, os: 'linux', architecture: 'amd64' });
			expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
		}
	});

	test('falls back on registry failures and timeouts', async () => {
		const f = fixture();
		for (const status of [401, 404, 429, 500]) {
			expect(await fetchImageCreatedAt(f.request, async () => new Response(null, { status }))).toBeNull();
		}
		expect(await fetchImageCreatedAt(f.request, async () => { throw new DOMException('Timed out', 'TimeoutError'); })).toBeNull();
	});

	test('follows blob CDN redirects without forwarding registry credentials', async () => {
		const f = fixture();
		const result = await fetchImageCreatedAt(f.request, async (url, init) => {
			if (url.includes('/blobs/')) return new Response(null, { status: 307, headers: { Location: 'https://cdn.example.com/config' } });
			if (url === 'https://cdn.example.com/config') {
				expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
				return new Response(f.documents.get(f.configDigest));
			}
			return f.fetcher(url, init);
		});
		expect(result).toBe(created);
	});

	test('preserves credentials for same-origin redirects', async () => {
		const f = fixture();
		expect(await fetchImageCreatedAt(f.request, async (url, init) => {
			if (url.includes('/blobs/')) return new Response(null, { status: 302, headers: { Location: '/config' } });
			if (url.endsWith('/config')) {
				expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
				return new Response(f.documents.get(f.configDigest));
			}
			return f.fetcher(url, init);
		})).toBe(created);
	});

	test('rejects blocked hosts, unsafe redirects and redirect loops', async () => {
		for (const registry of ['localhost:5000', '127.0.0.1:5000', '169.254.169.254']) {
			const f = fixture();
			f.request.registry = registry;
			expect(await fetchImageCreatedAt(f.request, f.fetcher)).toBeNull();
			expect(f.calls).toHaveLength(0);
		}
		for (const location of ['https://169.254.169.254/meta', 'http://registry.example.com/config', 'https://registry.example.com/loop']) {
			const f = fixture();
			let calls = 0;
			expect(await fetchImageCreatedAt(f.request, async () => {
				calls++;
				return new Response(null, { status: 307, headers: { Location: location } });
			})).toBeNull();
			expect(calls).toBe(location.endsWith('/loop') ? 5 : 1);
		}
	});

	test('rejects malformed digest and repository references before requesting metadata', async () => {
		for (const override of [{ digest: 'latest' }, { repo: '../other' }, { repo: 'team/app?tag=latest' }]) {
			const f = fixture();
			expect(await fetchImageCreatedAt({ ...f.request, ...override }, f.fetcher)).toBeNull();
			expect(f.calls).toHaveLength(0);
		}
	});

	test('rejects oversized Content-Length without reading the body', async () => {
		const f = fixture();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
		expect(await fetchImageCreatedAt(f.request, async () => new Response(stream, {
			headers: { 'Content-Length': String(2 * 1024 * 1024) }
		}))).toBeNull();
		expect(cancelled).toBe(true);
	});

	test('enforces the streaming cap without Content-Length and cancels unread chunks', async () => {
		const f = fixture();
		let chunks = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++;
				controller.enqueue(new Uint8Array(256 * 1024));
				if (chunks === 20) controller.close();
			},
			cancel() { cancelled = true; }
		});
		expect(await fetchImageCreatedAt(f.request, async () => new Response(stream))).toBeNull();
		expect(chunks).toBeGreaterThan(4);
		expect(chunks).toBeLessThan(20);
		expect(cancelled).toBe(true);
	});
});

test('normalizes the target daemon architecture without assuming the local runtime', () => {
	expect(imagePlatform('linux', 'x86_64')).toEqual({ os: 'linux', architecture: 'amd64' });
	expect(imagePlatform('linux', 'aarch64')).toEqual({ os: 'linux', architecture: 'arm64' });
	expect(imagePlatform('linux', 'armv7l')).toEqual({ os: 'linux', architecture: 'arm', variant: 'v7' });
	expect(imagePlatform('linux', 'armv6l')).toEqual({ os: 'linux', architecture: 'arm', variant: 'v6' });
	expect(imagePlatform(undefined, 'amd64')).toBeNull();
	expect(imagePlatform('linux', null)).toBeNull();
});
