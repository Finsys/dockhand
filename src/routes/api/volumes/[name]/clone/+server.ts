import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectVolume, createVolume, type CreateVolumeOptions, ensureVolumeHelperImage, dockerFetch, dockerJsonRequest, drainResponse } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditVolume } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const POST: RequestHandler = async (event) => {
	const { params, url, request, cookies } = event;
	const invalid = validateDockerIdParam(params.name, 'volume');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		const body = await request.json();
		const newName = body.name;

		if (!newName) {
			return json({ error: 'New volume name is required' }, { status: 400 });
		}

		// Get source volume info
		const sourceVolume = await inspectVolume(params.name, envIdNum);

		// Create new volume with same driver and options
		const options: CreateVolumeOptions = {
			name: newName,
			driver: sourceVolume.Driver || 'local',
			driverOpts: sourceVolume.Options || {},
			labels: { ...sourceVolume.Labels, 'dockhand.cloned.from': params.name }
		};

		const newVolume = await createVolume(options, envIdNum);

		// Copy data from source to destination using a temporary busybox container
		// Mount source read-only at /src and destination read-write at /dst
		await ensureVolumeHelperImage(envIdNum);

		const containerName = `dockhand-clone-${Date.now().toString(36)}`;
		const containerConfig = {
			Image: 'busybox:latest',
			Cmd: ['cp', '-a', '/src/.', '/dst/'],
			HostConfig: {
				Binds: [
					`${params.name}:/src:ro`,
					`${newName}:/dst`
				],
				AutoRemove: false
			},
			Labels: { 'dockhand.volume.helper': 'true' }
		};

		let copyCtrId: string | undefined;
		try {
			const createRes = await dockerJsonRequest<{ Id: string }>(
				`/containers/create?name=${encodeURIComponent(containerName)}`,
				{ method: 'POST', body: JSON.stringify(containerConfig) },
				envIdNum
			);
			copyCtrId = createRes.Id;

			await drainResponse(await dockerFetch(`/containers/${copyCtrId}/start`, { method: 'POST' }, envIdNum));

			// Wait for the copy to finish (must drain response to ensure wait completes)
			const waitRes = await dockerFetch(`/containers/${copyCtrId}/wait`, { method: 'POST' }, envIdNum);
			const waitBody = await waitRes.json().catch(() => ({ StatusCode: -1 }));
			if (waitBody.StatusCode !== 0) {
				throw new Error(`Volume copy failed with exit code ${waitBody.StatusCode}`);
			}
		} finally {
			if (copyCtrId) {
				await drainResponse(
					await dockerFetch(`/containers/${copyCtrId}?force=true`, { method: 'DELETE' }, envIdNum)
				).catch(() => { /* best effort cleanup */ });
			}
		}

		// Audit log
		await auditVolume(event, 'clone', newVolume.Name, `${params.name} → ${newName}`, envIdNum, {
			source: params.name,
			driver: options.driver
		});

		return json({ success: true, name: newVolume.Name });
	} catch (error: any) {
		console.error('Failed to clone volume:', error);
		return json({
			error: 'Failed to clone volume',
			details: error.message || String(error)
		}, { status: 500 });
	}
};
