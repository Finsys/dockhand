import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	startContainer,
	stopContainer,
	restartContainer,
	pauseContainer,
	unpauseContainer,
	removeContainer,
	removeImage,
	removeVolume,
	removeNetwork
} from '$lib/server/docker';
import {
	startStack,
	stopStack,
	restartStack,
	downStack,
	removeStack
} from '$lib/server/stacks';
import { deleteAutoUpdateSchedule, getAutoUpdateSetting, removePendingContainerUpdate } from '$lib/server/db';
import { unregisterSchedule } from '$lib/server/scheduler';
import { prefersJSON } from '$lib/server/sse';
import { createJob, appendLine, completeJob, failJob } from '$lib/server/jobs';

// SSE Event types
export type BatchEventType = 'start' | 'progress' | 'complete' | 'error';
export type ItemStatus = 'pending' | 'processing' | 'success' | 'error';

export interface BatchStartEvent {
	type: 'start';
	total: number;
}

export interface BatchProgressEvent {
	type: 'progress';
	id: string;
	name: string;
	status: ItemStatus;
	message?: string;
	error?: string;
	current: number;
	total: number;
}

export interface BatchCompleteEvent {
	type: 'complete';
	summary: {
		total: number;
		success: number;
		failed: number;
	};
}

export interface BatchErrorEvent {
	type: 'error';
	error: string;
}

export type BatchEvent = BatchStartEvent | BatchProgressEvent | BatchCompleteEvent | BatchErrorEvent;

// Supported operations per entity type
const ENTITY_OPERATIONS: Record<string, string[]> = {
	containers: ['start', 'stop', 'restart', 'pause', 'unpause', 'remove'],
	images: ['remove'],
	volumes: ['remove'],
	networks: ['remove'],
	stacks: ['start', 'stop', 'restart', 'down', 'remove']
};

// Permission mapping for entity operations
const PERMISSION_MAP: Record<string, Record<string, string>> = {
	containers: {
		start: 'start',
		stop: 'stop',
		restart: 'restart',
		pause: 'stop',
		unpause: 'start',
		remove: 'remove'
	},
	images: { remove: 'remove' },
	volumes: { remove: 'remove' },
	networks: { remove: 'remove' },
	stacks: {
		start: 'start',
		stop: 'stop',
		restart: 'restart',
		down: 'stop',
		remove: 'remove'
	}
};

interface BatchRequest {
	operation: string;
	entityType: string;
	items: Array<{ id: string; name: string }>;
	options?: {
		force?: boolean;
		removeVolumes?: boolean;
	};
}

// Concurrent execution helper with controlled parallelism
async function processWithConcurrency<T>(
	items: T[],
	concurrency: number,
	processor: (item: T, index: number) => Promise<void>
): Promise<void> {
	let currentIndex = 0;
	const total = items.length;

	async function processNext(): Promise<void> {
		while (currentIndex < total) {
			const index = currentIndex++;
			await processor(items[index], index);
		}
	}

	// Start 'concurrency' number of workers
	const workers = Array(Math.min(concurrency, total))
		.fill(null)
		.map(() => processNext());

	await Promise.all(workers);
}

/**
 * Unified batch operations endpoint (job pattern).
 * Handles bulk operations for containers, images, volumes, networks, and stacks.
 */
export const POST: RequestHandler = async ({ url, cookies, request }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Parse request body
	let body: BatchRequest;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { operation, entityType, items, options = {} } = body;

	// Validate entity type
	if (!ENTITY_OPERATIONS[entityType]) {
		return json(
			{ error: `Invalid entity type: ${entityType}. Supported: ${Object.keys(ENTITY_OPERATIONS).join(', ')}` },
			{ status: 400 }
		);
	}

	// Validate operation for entity type
	if (!ENTITY_OPERATIONS[entityType].includes(operation)) {
		return json(
			{ error: `Invalid operation '${operation}' for ${entityType}. Supported: ${ENTITY_OPERATIONS[entityType].join(', ')}` },
			{ status: 400 }
		);
	}

	// Validate items
	if (!items || !Array.isArray(items) || items.length === 0) {
		return json({ error: 'items array is required and must not be empty' }, { status: 400 });
	}

	// Permission check
	const permissionAction = PERMISSION_MAP[entityType][operation];
	if (auth.authEnabled && !(await auth.can(entityType as any, permissionAction, envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// Check if audit is needed (enterprise only)
	const needsAudit = auth.isEnterprise;

	// Sync path for API clients that prefer plain JSON (Accept: application/json only)
	if (prefersJSON(request)) {
		let successCount = 0;
		let failCount = 0;

		await processWithConcurrency(items, 3, async (item, index) => {
			const { id, name } = item;
			try {
				await executeOperation(entityType, operation, id, name, envIdNum, options, needsAudit);
				successCount++;
			} catch {
				failCount++;
			}
		});

		return json({
			type: 'complete',
			summary: { total: items.length, success: successCount, failed: failCount }
		});
	}

	// Job pattern: create job, process in background, return jobId immediately
	const job = createJob();

	(async () => {
		let successCount = 0;
		let failCount = 0;

		appendLine(job, { data: { type: 'start', total: items.length } });

		await processWithConcurrency(items, 3, async (item, index) => {
			const { id, name } = item;

			appendLine(job, {
				data: { type: 'progress', id, name, status: 'processing', current: index + 1, total: items.length }
			});

			try {
				await executeOperation(entityType, operation, id, name, envIdNum, options, needsAudit);
				appendLine(job, {
					data: { type: 'progress', id, name, status: 'success', current: index + 1, total: items.length }
				});
				successCount++;
			} catch (error: any) {
				appendLine(job, {
					data: {
						type: 'progress',
						id,
						name,
						status: 'error',
						error: error.message || 'Unknown error',
						current: index + 1,
						total: items.length
					}
				});
				failCount++;
			}
		});

		const completeEvent = {
			type: 'complete',
			summary: { total: items.length, success: successCount, failed: failCount }
		};
		appendLine(job, { data: completeEvent });
		completeJob(job, completeEvent);
	})().catch((err) => failJob(job, err.message));

	return json({ jobId: job.id });
};

/**
 * Execute a single operation on an entity.
 * Centralized operation execution to keep code DRY.
 */
async function executeOperation(
	entityType: string,
	operation: string,
	id: string,
	name: string,
	envIdNum: number | undefined,
	options: { force?: boolean; removeVolumes?: boolean },
	needsAudit: boolean
): Promise<void> {
	switch (entityType) {
		case 'containers':
			await executeContainerOperation(operation, id, name, envIdNum, options, needsAudit);
			break;
		case 'images':
			await executeImageOperation(operation, id, envIdNum, options);
			break;
		case 'volumes':
			await executeVolumeOperation(operation, id, envIdNum, options);
			break;
		case 'networks':
			await executeNetworkOperation(operation, id, envIdNum);
			break;
		case 'stacks':
			await executeStackOperation(operation, id, envIdNum, options);
			break;
		default:
			throw new Error(`Unsupported entity type: ${entityType}`);
	}
}

async function executeContainerOperation(
	operation: string,
	id: string,
	name: string,
	envIdNum: number | undefined,
	options: { force?: boolean },
	needsAudit: boolean
): Promise<void> {
	switch (operation) {
		case 'start':
			await startContainer(id, envIdNum);
			break;
		case 'stop':
			await stopContainer(id, envIdNum);
			break;
		case 'restart':
			await restartContainer(id, envIdNum);
			break;
		case 'pause':
			await pauseContainer(id, envIdNum);
			break;
		case 'unpause':
			await unpauseContainer(id, envIdNum);
			break;
		case 'remove':
			// In free edition, skip inspect (no audit needed)
			// In enterprise, we might want to audit but for batch ops we skip for performance
			await removeContainer(id, options.force ?? true, envIdNum);

			// Clean up auto-update schedule if exists
			try {
				const setting = await getAutoUpdateSetting(name, envIdNum);
				if (setting) {
					unregisterSchedule(setting.id, 'container_update');
					await deleteAutoUpdateSchedule(name, envIdNum);
				}
			} catch {
				// Ignore cleanup errors
			}

			// Clean up pending container update if exists
			try {
				if (envIdNum) {
					await removePendingContainerUpdate(envIdNum, id);
				}
			} catch {
				// Ignore cleanup errors
			}
			break;
		default:
			throw new Error(`Unsupported container operation: ${operation}`);
	}
}

async function executeImageOperation(
	operation: string,
	id: string,
	envIdNum: number | undefined,
	options: { force?: boolean }
): Promise<void> {
	switch (operation) {
		case 'remove':
			await removeImage(id, options.force ?? false, envIdNum);
			break;
		default:
			throw new Error(`Unsupported image operation: ${operation}`);
	}
}

async function executeVolumeOperation(
	operation: string,
	name: string,
	envIdNum: number | undefined,
	options: { force?: boolean }
): Promise<void> {
	switch (operation) {
		case 'remove':
			await removeVolume(name, options.force ?? false, envIdNum);
			break;
		default:
			throw new Error(`Unsupported volume operation: ${operation}`);
	}
}

async function executeNetworkOperation(
	operation: string,
	id: string,
	envIdNum: number | undefined
): Promise<void> {
	switch (operation) {
		case 'remove':
			await removeNetwork(id, envIdNum);
			break;
		default:
			throw new Error(`Unsupported network operation: ${operation}`);
	}
}

async function executeStackOperation(
	operation: string,
	name: string,
	envIdNum: number | undefined,
	options: { removeVolumes?: boolean; force?: boolean }
): Promise<void> {
	switch (operation) {
		case 'start': {
			const result = await startStack(name, envIdNum);
			if (!result.success) throw new Error(result.error || 'Failed to start stack');
			break;
		}
		case 'stop': {
			const result = await stopStack(name, envIdNum);
			if (!result.success) throw new Error(result.error || 'Failed to stop stack');
			break;
		}
		case 'restart': {
			const result = await restartStack(name, envIdNum);
			if (!result.success) throw new Error(result.error || 'Failed to restart stack');
			break;
		}
		case 'down': {
			const result = await downStack(name, envIdNum, options.removeVolumes ?? false);
			if (!result.success) throw new Error(result.error || 'Failed to down stack');
			break;
		}
		case 'remove': {
			const result = await removeStack(name, envIdNum, options.force ?? false);
			if (!result.success) throw new Error(result.error || 'Failed to remove stack');
			break;
		}
		default:
			throw new Error(`Unsupported stack operation: ${operation}`);
	}
}
