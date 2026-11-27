/**
 * Environment scope for stack operations under Enterprise RBAC. A stack call without an
 * environment targets Dockhand's own Docker daemon, and can() without an environmentId
 * merges every role, env-scoped ones included; so for a non-admin a missing environment
 * is refused rather than read as "no scope to check".
 */
export interface EnvScopeAuth {
	authEnabled: boolean;
	isEnterprise: boolean;
	isAdmin: boolean;
	canAccessEnvironment(environmentId: number): Promise<boolean>;
}

export async function deniesEnvScope(auth: EnvScopeAuth, envId: number | null | undefined): Promise<boolean> {
	if (!auth.authEnabled || !auth.isEnterprise) return false;
	if (!envId) return !auth.isAdmin;
	return !(await auth.canAccessEnvironment(envId));
}
