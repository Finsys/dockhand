/**
 * Parse a Docker image reference into its registry host, repository, and tag,
 * following Docker's own reference rules. Pure and dependency-free so it can be
 * unit-tested (and imported by the light semver layer) without pulling in the
 * native modules that live in docker.ts.
 *
 *   nginx:latest                        -> { registry: 'index.docker.io', repo: 'library/nginx', tag: 'latest' }
 *   ghcr.io/user/image:v1               -> { registry: 'ghcr.io', repo: 'user/image', tag: 'v1' }
 *   codeberg.org/forgejo/forgejo:15.0.2 -> { registry: 'codeberg.org', repo: 'forgejo/forgejo', tag: '15.0.2' }
 *   registry.example.com:5000/repo:tag  -> { registry: 'registry.example.com:5000', repo: 'repo', tag: 'tag' }
 */
export interface ImageReference {
	registry: string;
	repo: string;
	tag: string;
}

export function parseImageReference(imageName: string): ImageReference {
	let registry = 'index.docker.io'; // Docker Hub's actual API host.
	let repo = imageName;
	let tag = 'latest';

	// Drop a digest — irrelevant to tag/version lookups.
	if (repo.includes('@')) {
		repo = repo.split('@')[0];
	}

	// Split off the tag, but a colon before a `/` is a registry port, not a tag.
	const lastColon = repo.lastIndexOf(':');
	if (lastColon > -1) {
		const potentialTag = repo.slice(lastColon + 1);
		if (!potentialTag.includes('/')) {
			tag = potentialTag;
			repo = repo.slice(0, lastColon);
		}
	}

	// The first path segment is the registry only if it looks like a host
	// (has a dot or port, or is localhost) — otherwise it's part of the repo.
	const firstSlash = repo.indexOf('/');
	if (firstSlash > -1) {
		const firstPart = repo.slice(0, firstSlash);
		if (firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost') {
			registry = firstPart;
			repo = repo.slice(firstSlash + 1);
		}
	}

	if (registry === 'docker.io') registry = 'index.docker.io';

	// Docker Hub official images are namespaced under library/.
	if (registry === 'index.docker.io' && !repo.includes('/')) {
		repo = `library/${repo}`;
	}

	return { registry, repo, tag };
}

/** Every hostname that means "Docker Hub". */
const DOCKER_HUB_HOSTS = new Set([
	'index.docker.io',
	'docker.io',
	'registry-1.docker.io',
	'registry.docker.io',
	'hub.docker.com',
	'registry.hub.docker.com'
]);

export function isDockerHub(registry: string): boolean {
	return DOCKER_HUB_HOSTS.has(registry.toLowerCase());
}

export function isGhcr(registry: string): boolean {
	return registry.toLowerCase() === 'ghcr.io';
}
