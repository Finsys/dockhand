/**
 * Pure decision core for the WS exec gate. No imports, so it is unit-testable in
 * the bun runner without dragging in better-sqlite3 via auth/db. Deps are
 * injected; ws-auth.ts binds the real ones.
 *
 * Mirrors the REST gate `auth.can('containers','exec',envId)`: free edition /
 * auth-disabled / admin all pass, exactly as checkPermission() does; enterprise
 * requires the env-scoped `containers:exec` permission.
 */
export interface ExecAuth {
	userId: number;
	isAdmin: boolean;
	authDisabled: boolean;
}

export async function canExecDecision(
	auth: ExecAuth,
	environmentId: number | undefined | null,
	deps: {
		isEnterprise: () => Promise<boolean>;
		getPerms: (userId: number, envId: number) => Promise<{ containers?: string[] }>;
	}
): Promise<boolean> {
	if (auth.authDisabled) return true;
	if (auth.isAdmin) return true;
	if (!(await deps.isEnterprise())) return true;
	if (environmentId == null) return false;
	const perms = await deps.getPerms(auth.userId, environmentId);
	return perms.containers?.includes('exec') ?? false;
}
