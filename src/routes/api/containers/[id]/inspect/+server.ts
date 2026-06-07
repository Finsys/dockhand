import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectContainer, inspectImage } from '$lib/server/docker';
import { getSecretKeysToMask } from '$lib/server/db';
import { getStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import {
	detectImageEnvDivergence,
	detectImageLabelDivergence
} from '$lib/server/container-image-divergence';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const containerData = await inspectContainer(params.id, envIdNum);

		// Compute env/label divergence BEFORE masking, so the comparison
		// uses real values. Failure to inspect the image is non-fatal —
		// the field is omitted in that case.
		let divergence: { env: string[]; labels: string[] } | undefined;
		try {
			const imageRef = containerData.Config?.Image;
			if (imageRef) {
				const imageData: any = await inspectImage(imageRef, envIdNum);
				const imageEnv: string[] = imageData?.Config?.Env || [];
				const imageLabels: Record<string, string> = imageData?.Config?.Labels || {};
				divergence = {
					env: detectImageEnvDivergence(containerData.Config?.Env || [], imageEnv),
					labels: detectImageLabelDivergence(containerData.Config?.Labels, imageLabels)
				};
			}
		} catch {
			// image not present / not pullable / etc — drop the field
		}

		// Mask secret env vars for containers belonging to a Compose stack.
		// Uses compose file parsing to detect interpolation (e.g., MYSQL_PASSWORD=${db_secret}).
		const stackName = containerData.Config?.Labels?.['com.docker.compose.project'];
		if (stackName && Array.isArray(containerData.Config?.Env)) {
			const composeResult = await getStackComposeFile(stackName, envIdNum).catch(() => null);
			const secretKeys = await getSecretKeysToMask(stackName, envIdNum, composeResult?.content);
			if (secretKeys.size > 0) {
				containerData.Config.Env = containerData.Config.Env.map((entry: string) => {
					const eqIdx = entry.indexOf('=');
					if (eqIdx === -1) return entry;
					const key = entry.substring(0, eqIdx);
					if (secretKeys.has(key)) {
						return `${key}=***`;
					}
					return entry;
				});
			}
		}

		return json({ ...containerData, divergence });
	} catch (error) {
		console.error('Failed to inspect container:', error);
		return json({ error: 'Failed to inspect container' }, { status: 500 });
	}
};
