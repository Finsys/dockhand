// Run with REGISTRY_REQUEST_TIMEOUT=1 against registries that accept the request and
// never answer. Prints, per path, how long it took to give up and why.
import { mock } from 'bun:test';

let authSignal: AbortSignal | undefined;
mock.module('../../src/lib/server/docker', () => ({
	getRegistryAuthHeader: async (_url: string, _scope: string, _creds: unknown, signal?: AbortSignal) => {
		authSignal = signal;
		return null;
	}
}));

globalThis.fetch = ((_url: string, init?: RequestInit) =>
	new Promise((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) return; // no deadline: hangs, and the probe's own timeout catches it
		signal.addEventListener('abort', () => reject(signal.reason));
	})) as unknown as typeof fetch;

const { fetchDockerHubTags } = await import('../../src/lib/server/semver/strategies/docker-hub');
const { fetchGenericV2Tags } = await import('../../src/lib/server/semver/strategies/generic-v2');
const { getRegistryManifestDigestDirectDetailed } = await import('../../src/lib/server/registry/manifest-digest');

async function measure(run: () => Promise<unknown>) {
	const started = Date.now();
	try {
		const value = await run();
		return { ms: Date.now() - started, value };
	} catch (e) {
		return { ms: Date.now() - started, error: (e as Error).name };
	}
}

const hub = await measure(() => fetchDockerHubTags('library/nginx'));
const v2 = await measure(() => fetchGenericV2Tags('codeberg.org', 'forgejo/forgejo'));
const digest = await measure(() =>
	getRegistryManifestDigestDirectDetailed('ghcr.io/team/app:1', {
		parseRegistryUrl: (url) => ({ host: url, protocol: 'https' }),
		hubHosts: new Set(['docker.io']),
		listRegistries: async () => [],
		findCredentials: async () => null
	})
);
console.log(JSON.stringify({ hub, v2, digest, authSignal: authSignal instanceof AbortSignal }));
process.exit(0);
