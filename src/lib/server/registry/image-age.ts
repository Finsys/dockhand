import { createHash } from 'node:crypto';
import { isSafeNotificationUrl } from '../url-safety';
import { validImageCreatedAt } from '../minimum-release-age-core';

export interface ImagePlatform {
	os: string;
	architecture: string;
	variant?: string;
}

/** Docker /info reports kernel architecture names on some engines. Never use
 * Dockhand's own architecture: the target daemon may run on a different host. */
export function imagePlatform(os: unknown, architecture: unknown): ImagePlatform | null {
	if (typeof os !== 'string' || typeof architecture !== 'string' || !os || !architecture) return null;
	const arch = architecture.toLowerCase();
	const aliases: Record<string, string> = { x86_64: 'amd64', x64: 'amd64', aarch64: 'arm64', i386: '386', i686: '386' };
	const arm = /^armv([5-8])l?$/.exec(arch);
	return { os: os.toLowerCase(), architecture: arm ? 'arm' : aliases[arch] ?? arch, ...(arm ? { variant: `v${arm[1]}` } : {}) };
}

interface Descriptor {
	digest?: string;
	mediaType?: string;
	platform?: ImagePlatform;
	annotations?: Record<string, string>;
}
interface Manifest {
	mediaType?: string;
	schemaVersion?: number;
	manifests?: Descriptor[];
	config?: Descriptor;
}

const MANIFEST_TYPES = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
];
const CONFIG_TYPES = ['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'];
const validDigest = (digest: unknown): digest is string => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest);

export interface ImageAgeRequest {
	registry: string;
	repo: string;
	digest: string;
	platform: ImagePlatform;
	scheme: 'http' | 'https';
	authorization: string | null;
	signal?: AbortSignal;
}

type FetchMetadata = (url: string, init: RequestInit) => Promise<Response>;

/** Standard registry metadata only. All documents are fetched by digest and
 * hash-verified, including the selected platform manifest and its config blob.
 * Unknown/ambiguous metadata returns null so callers use first observation. */
export async function fetchImageCreatedAt(request: ImageAgeRequest, fetchMetadata: FetchMetadata = fetch): Promise<string | null> {
	try {
		const { registry, repo, platform } = request;
		if (!validDigest(request.digest) || !repo.split('/').every(part => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))) return null;
		const base = `${request.scheme}://${registry}/v2/${repo}`;
		const signal = request.signal ?? AbortSignal.timeout(8000);
		let digest = request.digest;
		for (let depth = 0; depth < 3; depth++) {
			const document = await readVerifiedJson(`${base}/manifests/${digest}`, digest, 1024 * 1024, MANIFEST_TYPES.join(', '));
			const manifest = document.body as Manifest;
			if (manifest?.schemaVersion !== 2 || !MANIFEST_TYPES.includes(manifest.mediaType ?? document.mediaType)) return null;
			if (manifest.manifests !== undefined) {
				if (!Array.isArray(manifest.manifests)) return null;
				const candidates = manifest.manifests.filter(entry =>
					entry?.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest' &&
					entry?.platform?.os === platform.os && entry.platform.architecture === platform.architecture &&
					(!platform.variant || entry.platform.variant === platform.variant)
				);
				// A daemon platform without a variant must not guess between ARM builds.
				if (candidates.length !== 1 || !validDigest(candidates[0].digest)) return null;
				digest = candidates[0].digest;
				continue;
			}
			const config = manifest.config;
			if (!validDigest(config?.digest) || !CONFIG_TYPES.includes(config?.mediaType ?? '')) return null;
			const { body: configBody } = await readVerifiedJson(`${base}/blobs/${config.digest}`, config.digest, 4 * 1024 * 1024, 'application/json');
			const body = configBody as {
				created?: unknown; os?: string; architecture?: string; variant?: string;
			};
			if (body?.os !== platform.os || body.architecture !== platform.architecture) return null;
			if (platform.variant && body.variant && body.variant !== platform.variant) return null;
			return validImageCreatedAt(body.created);
		}
		return null;

		async function readVerifiedJson(initialUrl: string, expectedDigest: string, limit: number, accept: string): Promise<{ body: unknown; mediaType: string }> {
			let url = new URL(initialUrl);
			let authorization = request.authorization;
			for (let hop = 0; hop < 5; hop++) {
				if (!isSafeNotificationUrl(url.href).ok || url.username || url.password) throw new Error('Unsafe registry metadata URL');
				const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'Dockhand/1.0' };
				if (authorization) headers.Authorization = authorization;
				const response = await fetchMetadata(url.href, { headers, redirect: 'manual', signal });
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					const location = response.headers.get('Location');
					await response.body?.cancel();
					if (!location) throw new Error('Missing metadata redirect location');
					const next = new URL(location, url);
					if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Insecure metadata redirect');
					if (next.origin !== url.origin) authorization = null;
					url = next;
					continue;
				}
				if (!response.ok || Number(response.headers.get('Content-Length')) > limit) {
					await response.body?.cancel();
					throw new Error('Registry metadata unavailable or too large');
				}
				const reader = response.body?.getReader();
				if (!reader) throw new Error('Empty registry metadata');
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > limit) throw new Error('Registry metadata too large');
						chunks.push(value);
					}
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
				}
				const bytes = Buffer.concat(chunks);
				if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw new Error('Registry metadata digest mismatch');
				return { body: JSON.parse(bytes.toString('utf8')), mediaType: (response.headers.get('Content-Type') ?? '').split(';')[0].trim() };
			}
			throw new Error('Too many metadata redirects');
		}
	} catch {
		return null;
	}
}
