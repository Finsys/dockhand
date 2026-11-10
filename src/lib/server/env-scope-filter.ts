/**
 * Keep only the rows a caller may see, given the environments they can access.
 *
 * `accessibleEnvIds === null` means full access (admin, or the free edition) and returns
 * every row. Otherwise a row is kept when its environment is one the caller can access, or
 * when it has no environment (a null-env / local row, which every caller may see). Pure, so
 * the env-scope rule is a unit test rather than something only a live RBAC setup reveals.
 */
export function filterByAccessibleEnv<T extends { environmentId: number | null }>(
	rows: T[],
	accessibleEnvIds: number[] | null
): T[] {
	if (accessibleEnvIds === null) return rows;
	return rows.filter((row) => row.environmentId === null || accessibleEnvIds.includes(row.environmentId));
}
