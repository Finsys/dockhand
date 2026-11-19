/**
 * readManifestIndex classifies a registry answer for the multi-arch check: an index body,
 * "no index here" (404 under an index-only Accept - measured: ghcr answers a single-arch
 * manifest that way), or a failure that is retryable (network, timeout, 429, 5xx,
 * unreadable body) or final (401, 403).
 */
import { describe, test, expect } from 'bun:test';
import { readManifestIndex } from '../src/lib/server/registry/manifest-digest';

const INDEX = { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] };

function fakeFetch(answer: Response | Error) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		if (answer instanceof Error) throw answer;
		return answer;
	}) as unknown as typeof fetch;
	return { f, calls };
}
const read = (answer: Response | Error) => {
	const { f, calls } = fakeFetch(answer);
	return { calls, result: readManifestIndex('ghcr.io', 'linuxserver/socket-proxy', '3.4.7-r0-ls103', 'Bearer t', 'https', f) };
};

describe('readManifestIndex', () => {
	test('an index body is returned as-is', async () => {
		const { result, calls } = read(new Response(JSON.stringify(INDEX), { status: 200 }));
		expect(await result).toEqual({ ok: true, body: INDEX });
		expect(calls[0].url).toBe('https://ghcr.io/v2/linuxserver/socket-proxy/manifests/3.4.7-r0-ls103');
		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers.Accept).toContain('application/vnd.oci.image.index.v1+json');
		expect(headers.Accept).not.toContain('application/vnd.oci.image.manifest.v1+json');
		expect(headers.Authorization).toBe('Bearer t');
	});

	test('404 means no index under that reference, not a failure', async () => {
		expect(await read(new Response('{}', { status: 404 })).result).toEqual({ ok: true, body: null });
	});

	test('401 and 403 are final', async () => {
		for (const status of [401, 403]) {
			const r = await read(new Response('', { status })).result;
			expect(r).toMatchObject({ ok: false, retryable: false });
		}
	});

	test('429 and 5xx are retryable', async () => {
		for (const status of [429, 500, 502, 503]) {
			const r = await read(new Response('', { status })).result;
			expect(r).toMatchObject({ ok: false, retryable: true });
		}
	});

	test('a timeout is retryable and named as one', async () => {
		const r = await read(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).result;
		expect(r).toEqual({ ok: false, retryable: true, reason: 'Registry did not answer in time: ghcr.io' });
	});

	test('a registry that never answers is cut off by the read timeout', async () => {
		const stalled = (async (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
		})) as unknown as typeof fetch;
		const r = await readManifestIndex('ghcr.io', 'linuxserver/socket-proxy', '3.4.7-r0-ls103', null, 'https', stalled, 30);
		expect(r).toEqual({ ok: false, retryable: true, reason: 'Registry did not answer in time: ghcr.io' });
	});

	test('the read is a GET carrying a timeout signal', async () => {
		const { result, calls } = read(new Response(JSON.stringify(INDEX), { status: 200 }));
		await result;
		expect(calls[0].init?.method).toBe('GET');
		expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	test('an unreadable body is retryable', async () => {
		const r = await read(new Response('not json', { status: 200 })).result;
		expect(r).toMatchObject({ ok: false, retryable: true });
	});
});
