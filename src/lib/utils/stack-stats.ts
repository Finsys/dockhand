// Stack resource totals, shared by the stacks page and GET /api/stack-stats so both show the same numbers.

export interface StackStats {
	cpuPercent: number;
	memoryUsage: number;
	memoryLimit: number;
	networkRx: number;
	networkTx: number;
	blockRead: number;
	blockWrite: number;
	runningCount: number;
}

export interface NamedStackStats extends StackStats {
	name: string;
}

type StatsSample = Omit<StackStats, 'runningCount'>;

/**
 * Sum the stats of a stack's running containers. `memoryLimit` is the max, not the sum:
 * every container reports the same host limit unless capped. Null when no running
 * container has a sample.
 */
export function sumStackStats(
	containers: Array<{ id: string; state: string }>,
	getStats: (id: string) => StatsSample | undefined
): StackStats | null {
	const total: StackStats = {
		cpuPercent: 0,
		memoryUsage: 0,
		memoryLimit: 0,
		networkRx: 0,
		networkTx: 0,
		blockRead: 0,
		blockWrite: 0,
		runningCount: 0
	};

	for (const container of containers) {
		if (container.state !== 'running') continue;
		const stats = getStats(container.id);
		if (!stats) continue;
		total.cpuPercent += stats.cpuPercent;
		total.memoryUsage += stats.memoryUsage;
		total.memoryLimit = Math.max(total.memoryLimit, stats.memoryLimit);
		total.networkRx += stats.networkRx;
		total.networkTx += stats.networkTx;
		total.blockRead += stats.blockRead;
		total.blockWrite += stats.blockWrite;
		total.runningCount++;
	}

	return total.runningCount === 0 ? null : total;
}

/**
 * Group containers by their compose project label and sum each group. Stacks with no
 * sampled running container are omitted. Sorted by name.
 */
export function groupStackStats(
	containers: Array<{ id: string; state: string; labels: Record<string, string> }>,
	statsById: Map<string, StatsSample>
): NamedStackStats[] {
	const byStack = new Map<string, Array<{ id: string; state: string }>>();
	for (const container of containers) {
		const project = container.labels?.['com.docker.compose.project'];
		if (!project) continue;
		const members = byStack.get(project);
		if (members) members.push(container);
		else byStack.set(project, [container]);
	}

	const result: NamedStackStats[] = [];
	for (const [name, members] of byStack) {
		const totals = sumStackStats(members, (id) => statsById.get(id));
		if (totals) result.push({ name, ...totals });
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}
