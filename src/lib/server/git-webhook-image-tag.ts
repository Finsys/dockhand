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

// Shared by webhook, scheduled and manual Git deployments in this process.
const activeStacks = new Set<number>();
export async function withGitStackDeployLock<T>(id: number, run: () => Promise<T>): Promise<T | null> {
	if (activeStacks.has(id)) return null;
	activeStacks.add(id);
	try { return await run(); } finally { activeStacks.delete(id); }
}
