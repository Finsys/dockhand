/**
 * Container Start Task
 *
 * Starts an existing container on a cron schedule. The container is expected
 * to stop on its own when its work is complete.
 */

import type { ScheduleTrigger } from '../../db';
import {
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog,
	updateContainerStartLastStarted
} from '../../db';
import { listContainers, startContainer } from '../../docker';

interface ContainerStartDetails {
	mode: 'scheduled_start';
	containerId?: string;
	previousState?: string;
	reason?: string;
}

export async function runContainerStart(
	settingId: number,
	containerName: string,
	environmentId: number | null | undefined,
	triggeredBy: ScheduleTrigger
): Promise<void> {
	const envId = environmentId ?? undefined;
	const startTime = Date.now();

	const execution = await createScheduleExecution({
		scheduleType: 'container_start',
		scheduleId: settingId,
		environmentId: environmentId ?? null,
		entityName: containerName,
		triggeredBy,
		status: 'running'
	});

	await updateScheduleExecution(execution.id, {
		startedAt: new Date().toISOString()
	});

	const log = async (message: string) => {
		console.log(`[Container Start] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	try {
		await log(`Looking up container: ${containerName}`);

		const containers = await listContainers(true, envId);
		const container = containers.find((item) => item.name === containerName);

		if (!container) {
			await log(`Container not found: ${containerName}`);
			await updateScheduleExecution(execution.id, {
				status: 'failed',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				errorMessage: 'Container not found'
			});
			return;
		}

		if (container.state === 'running') {
			await log(`Container already running: ${containerName}`);
			await updateScheduleExecution(execution.id, {
				status: 'skipped',
				completedAt: new Date().toISOString(),
				duration: Date.now() - startTime,
				details: {
					mode: 'scheduled_start',
					containerId: container.id,
					previousState: container.state,
					reason: 'Container already running'
				} satisfies ContainerStartDetails
			});
			return;
		}

		await log(`Starting container ${containerName} (${container.id})`);
		await startContainer(container.id, envId);
		await updateContainerStartLastStarted(containerName, envId);
		await log(`Container started successfully`);

		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			details: {
				mode: 'scheduled_start',
				containerId: container.id,
				previousState: container.state
			} satisfies ContainerStartDetails
		});
	} catch (error: any) {
		await log(`Error: ${error.message}`);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: error.message
		});
	}
}
