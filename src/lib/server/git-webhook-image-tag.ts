/** Docker distribution tag syntax, limited to 128 ASCII characters. */
export function resolveWebhookImageTag(raw: string | null, current?: string): string {
	const tag = raw || current || 'latest';
	if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error('Invalid IMAGE_TAG');
	return tag;
}

export function parseWebhookImageTag(values: string[]): { supplied: boolean; raw: string | null } {
	if (values.length > 1) throw new Error('IMAGE_TAG must be provided only once');
	const raw = values[0] ?? null;
	if (raw && !/^[\w][\w.-]{0,127}$/.test(raw)) throw new Error('Invalid IMAGE_TAG');
	return { supplied: values.length === 1, raw };
}

/** Preserve the existing response contract when the tag parameter is absent. */
export function webhookDeployStatus(supplied: boolean, success: boolean, concurrent: boolean): number {
	return !supplied || success ? 200 : concurrent ? 409 : 500;
}

// Ordinary deployments retain their existing concurrency. A tagged webhook must
// not modify the shared environment while any Git deployment is using it.
const activeDeployments = new Map<number, number>();
const taggedDeployments = new Map<number, Promise<void>>();

export async function withGitStackDeployLock<T>(id: number, tagged: boolean, run: () => Promise<T>): Promise<T | null> {
	if (tagged) {
		if (taggedDeployments.has(id) || activeDeployments.has(id)) return null;
		let release!: () => void;
		const done = new Promise<void>((resolve) => { release = resolve; });
		taggedDeployments.set(id, done);
		try { return await run(); } finally { taggedDeployments.delete(id); release(); }
	}
	while (taggedDeployments.has(id)) await taggedDeployments.get(id);
	activeDeployments.set(id, (activeDeployments.get(id) ?? 0) + 1);
	try { return await run(); } finally {
		const remaining = (activeDeployments.get(id) ?? 1) - 1;
		if (remaining) activeDeployments.set(id, remaining);
		else activeDeployments.delete(id);
	}
}
