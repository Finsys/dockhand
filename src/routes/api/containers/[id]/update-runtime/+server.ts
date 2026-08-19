/**
 * POST /api/containers/[id]/update-runtime
 *
 * In-place update of a running container's restart policy, CPU/memory limits,
 * blkio weights, and pids limit — the only properties Docker can change
 * without recreating the container. The body must contain ONLY fields from
 * IN_PLACE_UPDATE_FIELDS (see docker.ts); any unknown fields are silently
 * dropped so a confused or malicious caller can't sneak a recreate-only
 * field (image, env, ports, etc.) through this path.
 *
 * Returns Docker's response — typically `{ Warnings: string[] | null }`.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { inspectContainer, updateContainerRuntime, IN_PLACE_UPDATE_FIELDS, type InPlaceUpdateField } from '$lib/server/docker';

/**
 * @openapi
 * summary: Update a running container's restart policy and/or CPU/memory/blkio/pids limits in-place (no recreate)
 * path: id:string! Container id (from GET /api/containers)
 * query: env:integer Environment id (from GET /api/environments)
 * body: {RestartPolicy:{}, CpuShares:integer, CpuPeriod:integer, CpuQuota:integer, CpuRealtimePeriod:integer, CpuRealtimeRuntime:integer, CpusetCpus:string, CpusetMems:string, NanoCpus:integer, Memory:integer, MemorySwap:integer, MemoryReservation:integer, MemorySwappiness:integer, KernelMemory:integer, BlkioWeight:integer, BlkioWeightDevice:array<string>, BlkioDeviceReadBps:array<string>, BlkioDeviceWriteBps:array<string>, BlkioDeviceReadIOps:array<string>, BlkioDeviceWriteIOps:array<string>, PidsLimit:integer} (unsupported fields are silently dropped)
 * body-example: {"Memory":536870912,"PidsLimit":512}
 * resp-200: {success:boolean!, warnings:array<string>}
 * resp-400: Invalid JSON body, or no supported fields were provided
 * resp-403: Permission denied
 * resp-404: Container not found
 * resp-500: Update failed
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Same permission as the recreate-style update — anyone who could edit
	// the container the slow way should be able to edit it the fast way.
	if (auth.authEnabled && !await auth.can('containers', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	// Sanity-check: at least one allowed field must be present. Empty/all-unknown
	// payloads get a clear error rather than silently calling Docker with {}.
	const allowed = new Set<string>(IN_PLACE_UPDATE_FIELDS);
	const filtered: Partial<Record<InPlaceUpdateField, unknown>> = {};
	for (const [k, v] of Object.entries(body)) {
		if (allowed.has(k) && v !== undefined) filtered[k as InPlaceUpdateField] = v;
	}
	if (Object.keys(filtered).length === 0) {
		return json({
			error: 'No supported fields provided',
			supportedFields: Array.from(allowed)
		}, { status: 400 });
	}

	try {
		const result = await updateContainerRuntime(params.id, filtered, envIdNum);

		// Audit log — include which fields were touched, not their values
		// (CPU/memory numbers are non-sensitive, but the audit row stays
		// cleaner if we just record the keys).
		let containerName = params.id;
		try {
			const inspect = await inspectContainer(params.id, envIdNum);
			containerName = inspect.Name?.replace(/^\//, '') || params.id;
		} catch { /* fallback to id */ }
		await auditContainer(event, 'update', params.id, containerName, envIdNum, {
			inPlace: true,
			fields: Object.keys(filtered),
			warnings: result.Warnings ?? []
		});

		return json({ success: true, warnings: result.Warnings ?? [] });
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: 'Container not found' }, { status: 404 });
		}
		return json({ error: error?.message || 'Update failed' }, { status: 500 });
	}
};
