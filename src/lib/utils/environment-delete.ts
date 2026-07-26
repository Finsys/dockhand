export interface EnvironmentDeleteCounts {
	stackCount: number;
	gitStackCount: number;
	unknown: boolean;
}

type FetchEnvironmentDeleteCounts = (input: string) => Promise<Response>;

async function readArray(response: Response | null): Promise<{ count: number; unknown: boolean }> {
	if (!response?.ok) {
		return { count: 0, unknown: true };
	}

	try {
		const value: unknown = await response.json();
		return Array.isArray(value)
			? { count: value.length, unknown: false }
			: { count: 0, unknown: true };
	} catch {
		return { count: 0, unknown: true };
	}
}

export async function fetchEnvironmentDeleteCounts(
	environmentId: number,
	fetcher: FetchEnvironmentDeleteCounts = fetch
): Promise<EnvironmentDeleteCounts> {
	const [stacksResponse, gitStacksResponse] = await Promise.all([
		fetcher(`/api/stacks?env=${environmentId}`).catch(() => null),
		fetcher(`/api/git/stacks?env=${environmentId}`).catch(() => null)
	]);
	const [stacks, gitStacks] = await Promise.all([
		readArray(stacksResponse),
		readArray(gitStacksResponse)
	]);

	return {
		stackCount: stacks.count,
		gitStackCount: gitStacks.count,
		unknown: stacks.unknown || gitStacks.unknown
	};
}
