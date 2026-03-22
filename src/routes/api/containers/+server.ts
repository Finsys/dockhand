import { json } from '@sveltejs/kit';
import { listContainers, createContainer, pullImage, EnvironmentNotFoundError, DockerConnectionError, type CreateContainerOptions } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { hasEnvironments } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const all = url.searchParams.get('all') !== 'false';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// Early return if no environments configured (fresh install)
	if (!await hasEnvironments()) {
		return json([]);
	}

	// Early return if no environment specified
	if (!envIdNum) {
		return json([]);
	}

	try {
		const containers = await listContainers(all, envIdNum);
		return json(containers);
	} catch (error: any) {
		// Return 404 for missing environment so frontend can clear stale localStorage
		if (error instanceof EnvironmentNotFoundError) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}
		if (!(error instanceof DockerConnectionError)) {
			console.error('Error listing containers:', error);
		}
		// Return empty array instead of error to allow UI to load
		return json([]);
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { startAfterCreate, ...options } = body;

		// Check if image needs to be pulled
		try {
			console.log(`Attempting to create container with image: ${options.image}`);
			const container = await createContainer(options, envIdNum);

			// Start the container if requested
			if (startAfterCreate) {
				await container.start();
			}

			// Audit log
		await auditContainer(event, 'create', container.id, options.name, envIdNum, { image: options.image });

			return json({ success: true, id: container.id });
		} catch (createError: any) {
			// If error is due to missing image, try to pull it first
			if (createError.statusCode === 404 && createError.json?.message?.includes('No such image')) {
				console.log(`Image ${options.image} not found locally. Pulling...`);

				try {
					// Pull the image
					await pullImage(options.image, undefined, envIdNum);
					console.log(`Successfully pulled image: ${options.image}`);

					// Retry creating the container
					const container = await createContainer(options, envIdNum);

					// Start the container if requested
					if (startAfterCreate) {
						await container.start();
					}

					// Audit log
		await auditContainer(event, 'create', container.id, options.name, envIdNum, { image: options.image, imagePulled: true });

					return json({ success: true, id: container.id, imagePulled: true });
				} catch (pullError) {
					console.error('Error pulling image:', pullError);
					return json({
						error: 'Failed to pull image',
						details: `Could not pull image ${options.image}: ${String(pullError)}`
					}, { status: 500 });
				}
			}

			// If it's a different error, rethrow it
			throw createError;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[Container] Create failed: ${message}`);
		return json({ error: 'Failed to create container', details: message }, { status: 500 });
	}
};
