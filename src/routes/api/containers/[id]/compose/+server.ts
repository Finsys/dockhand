import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectContainer, inspectImage } from '$lib/server/docker';
import { getSecretKeysToMask } from '$lib/server/db';
import { getStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { inspectToCompose, type DockerInspect } from '$lib/utils/inspect-to-compose';

/**
 * GET /api/containers/{id}/compose - Generate a docker-compose fragment from a container
 *
 * @openapi
 * summary: Generate a docker-compose service definition from a running container's inspect (requires the 'view' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: {compose:string, composeFullEnv:string, serviceName:string, stackProject:string}
 * resp-200-desc: compose keeps only user-set env; composeFullEnv keeps every env var (incl. image-inherited); stackProject is the compose project the container already belongs to, or null
 * resp-403: Permission denied
 * resp-500: Failed to inspect the container
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('containers', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const containerData = (await inspectContainer(params.id, envIdNum)) as DockerInspect;

		const labels = containerData.Config?.Labels ?? {};
		const stackProject = labels['com.docker.compose.project'] ?? null;
		const serviceName =
			labels['com.docker.compose.service'] ||
			(containerData.Name?.startsWith('/') ? containerData.Name.slice(1) : containerData.Name) ||
			'app';

		// Mask secret env vars for a compose-stack container, exactly like the inspect
		// endpoint - `containers:view` must never expose secrets that inspect hides.
		if (stackProject && Array.isArray(containerData.Config?.Env)) {
			const composeResult = await getStackComposeFile(stackProject, envIdNum).catch(() => null);
			const secretKeys = await getSecretKeysToMask(stackProject, envIdNum, composeResult?.content);
			if (secretKeys.size > 0) {
				containerData.Config!.Env = containerData.Config!.Env!.map((entry: string) => {
					const eqIdx = entry.indexOf('=');
					if (eqIdx === -1) return entry;
					return secretKeys.has(entry.substring(0, eqIdx)) ? `${entry.substring(0, eqIdx)}=***` : entry;
				});
			}
		}

		// Inspect the image so image-inherited env / entrypoint / cmd / labels can be
		// subtracted (best effort - if the image is gone, we keep everything).
		let imageEnv: string[] | null = null;
		let imageEntrypoint: string[] | null = null;
		let imageCmd: string[] | null = null;
		let imageLabels: Record<string, string> | null = null;
		let imageExposedPorts: Record<string, unknown> | null = null;
		try {
			const imageRef = containerData.Config?.Image;
			if (imageRef) {
				const imageData: any = await inspectImage(imageRef, envIdNum);
				imageEnv = imageData?.Config?.Env ?? null;
				imageEntrypoint = imageData?.Config?.Entrypoint ?? null;
				imageCmd = imageData?.Config?.Cmd ?? null;
				imageLabels = imageData?.Config?.Labels ?? null;
				imageExposedPorts = imageData?.Config?.ExposedPorts ?? null;
			}
		} catch {
			// image not present / not pullable - fall back to keeping all values
		}

		const compose = inspectToCompose(containerData, {
			serviceName,
			imageEnv,
			imageEntrypoint,
			imageCmd,
			imageLabels,
			imageExposedPorts
		});
		// Same document but keeping every env var (the "only user-set env" toggle off).
		const composeFullEnv = inspectToCompose(containerData, {
			serviceName,
			imageEntrypoint,
			imageCmd,
			imageLabels,
			imageExposedPorts
		});

		return json({ compose, composeFullEnv, serviceName, stackProject });
	} catch (error: any) {
		return json({ error: error.message || 'Failed to generate compose' }, { status: 500 });
	}
};
