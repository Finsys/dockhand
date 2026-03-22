import { json, type RequestHandler } from '@sveltejs/kit';
import dependencies from '$lib/data/dependencies.json';
import { DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE } from '$lib/server/scanner';

// Extract version tag from image string (e.g., "anchore/grype:v0.110.0" -> "v0.110.0")
function imageTag(image: string): string {
	return image.split(':')[1] || 'latest';
}

// External tools used by Dockhand (Docker images)
const externalTools = [
	{
		name: 'anchore/grype',
		version: imageTag(DEFAULT_GRYPE_IMAGE),
		license: 'Apache-2.0',
		repository: 'https://github.com/anchore/grype'
	},
	{
		name: 'aquasec/trivy',
		version: imageTag(DEFAULT_TRIVY_IMAGE),
		license: 'Apache-2.0',
		repository: 'https://github.com/aquasecurity/trivy'
	}
];

export const GET: RequestHandler = async () => {
	// Combine npm dependencies with external tools, exclude dockhand itself
	const allDependencies = [...dependencies, ...externalTools]
		.filter((dep) => dep.name !== 'dockhand')
		.sort((a, b) => a.name.localeCompare(b.name));
	return json(allDependencies);
};
