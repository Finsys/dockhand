import { writable, derived } from 'svelte/store';
import { environments } from './environment';

export interface Permissions {
	containers: string[];
	images: string[];
	volumes: string[];
	networks: string[];
	stacks: string[];
	environments: string[];
	registries: string[];
	notifications: string[];
	configsets: string[];
	settings: string[];
	users: string[];
	git: string[];
	license: string[];
	audit_logs: string[];
	activity: string[];
	schedules: string[];
}

export interface AuthUser {
	id: number;
	username: string;
	email?: string;
	displayName?: string;
	avatar?: string;
	isAdmin: boolean;
	provider: 'local' | 'ldap' | 'oidc';
	permissions: Permissions;
}

export interface AuthState {
	user: AuthUser | null;
	loading: boolean;
	authEnabled: boolean;
	authenticated: boolean;
}

function createAuthStore() {
	const { subscribe, set, update } = writable<AuthState>({
		user: null,
		loading: true,
		authEnabled: false,
		authenticated: false
	});

	return {
		subscribe,

		/**
		 * Check current session status
		 * Should be called on app init
		 */
		async check() {
			update(state => ({ ...state, loading: true }));
			try {
				const response = await fetch('/api/auth/session');
				const data = await response.json();

				if (data.error) {
					set({
						user: null,
						loading: false,
						authEnabled: false,
						authenticated: false
					});
					return;
				}

				set({
					user: data.user || null,
					loading: false,
					authEnabled: data.authEnabled,
					authenticated: data.authenticated
				});
			} catch {
				set({
					user: null,
					loading: false,
					authEnabled: false,
					authenticated: false
				});
			}
		},

		/**
		 * Login with username and password
		 */
		async login(username: string, password: string, mfaToken?: string, provider: string = 'local'): Promise<{
			success: boolean;
			error?: string;
			requiresMfa?: boolean;
		}> {
			try {
				const response = await fetch('/api/auth/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ username, password, mfaToken, provider })
				});

				const data = await response.json();

				if (!response.ok) {
					return { success: false, error: data.error || 'Login failed' };
				}

				if (data.requiresMfa) {
					return { success: true, requiresMfa: true };
				}

				if (data.success && data.user) {
					// Refresh session to get full user with permissions
					await this.check();
					return { success: true };
				}

				return { success: false, error: 'Login failed' };
			} catch (error) {
				return { success: false, error: 'Network error' };
			}
		},

		/**
		 * Logout and clear session
		 */
		async logout() {
			try {
				await fetch('/api/auth/logout', { method: 'POST' });
			} finally {
				// Clear auth state
				set({
					user: null,
					loading: false,
					authEnabled: true, // Keep authEnabled as we know it was on
					authenticated: false
				});
				// Clear environment data to prevent showing stale info on login screen
				environments.clear();
			}
		},

		/**
		 * Check if user has a specific permission
		 * When auth is disabled, returns true (full access)
		 */
		hasPermission(user: AuthUser | null, authEnabled: boolean, resource: keyof Permissions, action: string): boolean {
			// If auth is disabled, everything is allowed
			if (!authEnabled) return true;

			// If no user and auth is enabled, deny
			if (!user) return false;

			// Admins can do anything
			if (user.isAdmin) return true;

			// Check specific permission
			const permissions = user.permissions[resource];
			return permissions?.includes(action) ?? false;
		}
	};
}

export const authStore = createAuthStore();

// Derived store for easy permission checking
export const canAccess = derived(authStore, ($auth) => {
	return (resource: keyof Permissions, action: string): boolean => {
		// If auth is disabled, everything is allowed
		if (!$auth.authEnabled) return true;

		// If not authenticated and auth is enabled, deny
		if (!$auth.authenticated || !$auth.user) return false;

		// Admins can do anything
		if ($auth.user.isAdmin) return true;

		// Check specific permission
		const permissions = $auth.user.permissions?.[resource];
		return permissions?.includes(action) ?? false;
	};
});

// Derived store to check if user has ANY permission for a resource
// Used for menu visibility - show menu if user has any access to that resource
export const hasAnyAccess = derived(authStore, ($auth) => {
	return (resource: keyof Permissions): boolean => {
		// If auth is disabled, everything is allowed
		if (!$auth.authEnabled) return true;

		// If not authenticated and auth is enabled, deny
		if (!$auth.authenticated || !$auth.user) return false;

		// Admins can do anything
		if ($auth.user.isAdmin) return true;

		// Check if user has ANY permission for this resource
		const permissions = $auth.user.permissions?.[resource];
		return permissions && permissions.length > 0;
	};
});

// Derived store for whether auth is required for the current session
export const requiresAuth = derived(authStore, ($auth) => {
	return $auth.authEnabled && !$auth.authenticated;
});

// Derived store for admin check - true if auth disabled OR user is admin
export const isAdmin = derived(authStore, ($auth) => {
	if (!$auth.authEnabled) return true;
	return $auth.user?.isAdmin ?? false;
});
