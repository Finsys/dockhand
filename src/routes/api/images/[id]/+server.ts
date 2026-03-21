import { json } from '@sveltejs/kit';
import { removeImage, inspectImage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditImage } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'image');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const force = url.searchParams.get('force') === 'true';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		console.log('Delete image request - params.id:', params.id, 'force:', force, 'envId:', envIdNum);

		// Get image name for audit before deleting
		let imageName = params.id;
		try {
			const imageInfo = await inspectImage(params.id, envIdNum);
			imageName = imageInfo.RepoTags?.[0] || params.id;
		} catch (e) {
			console.log('Could not inspect image:', e);
			// Use ID if can't get name
		}

		await removeImage(params.id, force, envIdNum);

		// Audit log
		await auditImage(event, 'delete', params.id, imageName, envIdNum, { force });

		return json({ success: true });
	} catch (error: any) {
		console.error('Error removing image:', error.message, 'statusCode:', error.statusCode, 'json:', error.json);

		// Handle specific Docker errors
		if (error.statusCode === 409) {
			const message = error.json?.message || error.message || '';
			if (message.includes('being used by running container')) {
				return json({ error: 'Cannot delete image: it is being used by a running container. Stop the container first.' }, { status: 409 });
			}
			if (message.includes('has dependent child images')) {
				return json({ error: 'Cannot delete image: it has dependent child images. Delete those first or use force delete.' }, { status: 409 });
			}
			return json({ error: message || 'Image is in use and cannot be deleted' }, { status: 409 });
		}

		return json({ error: 'Failed to remove image' }, { status: 500 });
	}
};
