/**
 * Centralized Authorization Service
 *
 * This module provides a unified interface for all authorization checks in the application.
 * It consolidates the authorization logic that was previously scattered across API endpoints.
 *
 * Feature Access Model:
 * - Free Edition: SSO/OIDC + local users, all authenticated users have full access
 * - Enterprise Edition: LDAP, MFA, RBAC with fine-grained permissions
 *
 * Usage:
 *   import { authorize } from '$lib/server/authorize';
 *
 *   // In API handler:
 *   const auth = authorize(cookies);
 *
 *   // Check authentication only
 *   if (!auth.isAuthenticated) {
 *     return json({ error: 'Authentication required' }, { status: 401 });
 *   }
 *
 *   // Check specific permission
 *   if (!await auth.can('settings', 'edit')) {
 *     return json({ error: 'Permission denied' }, { status: 403 });
 *   }
 *
 *   // Check permission in environment context
 *   if (!await auth.canAccessEnvironment(envId)) {
 *     return json({ error: 'Access denied' }, { status: 403 });
 *   }
 *
 *   // Require enterprise license
 *   if (!auth.isEnterprise) {
 *     return json({ error: 'Enterprise license required' }, { status: 403 });
 *   }
 */

import type { Cookies } from '@sveltejs/kit';
import type { Permissions } from './db';
import { getUserAccessibleEnvironments, userCanAccessEnvironment, userHasAdminRole } from './db';
import { validateSession, isAuthEnabled, checkPermission, type AuthenticatedUser } from './auth';
import { isEnterprise } from './license';

export interface AuthorizationContext {
	/** Whether authentication is enabled globally */
	authEnabled: boolean;

	/** Whether the request is authenticated (has valid session) */
	isAuthenticated: boolean;

	/** The authenticated user, if any */
	user: AuthenticatedUser | null;

	/** Whether the user has admin privileges */
	isAdmin: boolean;

	/** Whether an enterprise license is active */
	isEnterprise: boolean;

	/**
	 * Check if the user has a specific permission.
	 * In free edition, all authenticated users have full access.
	 * In enterprise edition, checks RBAC permissions.
	 * @param environmentId - Optional: check permission in context of specific environment
	 */
	can: (resource: keyof Permissions, action: string, environmentId?: number) => Promise<boolean>;

	/**
	 * Check if user can access a specific environment.
	 * Returns true if user has any role that applies to this environment.
	 */
	canAccessEnvironment: (environmentId: number) => Promise<boolean>;

	/**
	 * Get list of environment IDs the user can access.
	 * Returns null if user has access to ALL environments.
	 * Returns empty array if user has no access.
	 */
	getAccessibleEnvironmentIds: () => Promise<number[] | null>;

	/**
	 * Check if user can manage other users.
	 * Returns true if:
	 * - Auth is disabled (initial setup)
	 * - User is admin
	 * - Free edition (all users have full access)
	 * - Enterprise edition with users permission
	 */
	canManageUsers: () => Promise<boolean>;

	/**
	 * Check if user can manage settings (OIDC, LDAP configs, etc).
	 * Returns true if:
	 * - Auth is disabled (initial setup)
	 * - User is authenticated and (free edition or has settings permission)
	 */
	canManageSettings: () => Promise<boolean>;

	/**
	 * Check if user can view audit logs.
	 * Audit logs are an enterprise-only feature.
	 * Returns true if:
	 * - Enterprise license is active AND
	 * - (User is admin OR has audit_logs view permission)
	 */
	canViewAuditLog: () => Promise<boolean>;
}

/**
 * Create an authorization context from cookies.
 * This is the main entry point for authorization checks.
 */
export async function authorize(cookies: Cookies): Promise<AuthorizationContext> {
	const authEnabled = await isAuthEnabled();
	const enterprise = await isEnterprise();
	const user = authEnabled ? await validateSession(cookies) : null;

	// Determine admin status:
	// - Free edition: all authenticated users are effectively admins (full access)
	// - Enterprise edition: check if user has Admin role assigned
	let isAdmin = false;
	if (user) {
		if (!enterprise) {
			// Free edition: everyone is admin
			isAdmin = true;
		} else {
			// Enterprise: check for Admin role assignment
			isAdmin = await userHasAdminRole(user.id);
		}
	}

	const ctx: AuthorizationContext = {
		authEnabled,
		isAuthenticated: !!user,
		user,
		isAdmin,
		isEnterprise: enterprise,

		async can(resource: keyof Permissions, action: string, environmentId?: number): Promise<boolean> {
			// If auth is disabled, allow everything (initial setup)
			if (!authEnabled) return true;

			// Must be authenticated
			if (!user) return false;

			// Use the existing checkPermission which already handles free vs enterprise
			// Pass environmentId for environment-scoped permission checks
			return checkPermission(user, resource, action, environmentId);
		},

		async canAccessEnvironment(environmentId: number): Promise<boolean> {
			// If auth is disabled, allow everything (initial setup)
			if (!authEnabled) return true;

			// Must be authenticated
			if (!user) return false;

			// Admins can access all environments
			if (user.isAdmin) return true;

			// In free edition, all authenticated users have full access
			if (!enterprise) return true;

			// In enterprise, check if user has any role for this environment
			return userCanAccessEnvironment(user.id, environmentId);
		},

		async getAccessibleEnvironmentIds(): Promise<number[] | null> {
			// If auth is disabled, return null (all environments)
			if (!authEnabled) return null;

			// Must be authenticated
			if (!user) return [];

			// Admins can access all environments
			if (user.isAdmin) return null;

			// In free edition, all authenticated users have full access
			if (!enterprise) return null;

			// In enterprise, get accessible environment IDs
			return getUserAccessibleEnvironments(user.id);
		},

		async canManageUsers(): Promise<boolean> {
			// If auth is disabled, allow (initial setup when no users exist)
			if (!authEnabled) return true;

			// Must be authenticated
			if (!user) return false;

			// Admins can always manage users
			if (user.isAdmin) return true;

			// In free edition, all authenticated users have full access
			if (!enterprise) return true;

			// In enterprise, check RBAC
			return checkPermission(user, 'users', 'create');
		},

		async canManageSettings(): Promise<boolean> {
			// If auth is disabled, allow (initial setup)
			if (!authEnabled) return true;

			// Must be authenticated
			if (!user) return false;

			// In free edition, all authenticated users have full access
			if (!enterprise) return true;

			// In enterprise, check RBAC
			return checkPermission(user, 'settings', 'edit');
		},

		async canViewAuditLog(): Promise<boolean> {
			// Audit logs are enterprise-only
			if (!enterprise) return false;

			// If auth is disabled, allow access (enterprise-only protection is enough)
			if (!authEnabled) return true;

			// Must be authenticated
			if (!user) return false;

			// Admins can always view audit logs
			if (user.isAdmin) return true;

			// Check for audit_logs permission
			return checkPermission(user, 'audit_logs' as keyof Permissions, 'view');
		}
	};

	return ctx;
}

/**
 * Helper to create a standard 401 response
 */
export function unauthorized() {
	return { error: 'Authentication required', status: 401 };
}

/**
 * Helper to create a standard 403 response
 */
export function forbidden(reason: string = 'Permission denied') {
	return { error: reason, status: 403 };
}

/**
 * Helper to create enterprise required response
 */
export function enterpriseRequired() {
	return { error: 'Enterprise license required', status: 403 };
}
