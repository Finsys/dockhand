import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getLdapConfigs, createLdapConfig } from '$lib/server/db';
import { auditLdapConfig } from '$lib/server/audit';

// GET /api/auth/ldap - List all LDAP configurations
/**
 * @openapi
 * summary: List all configured LDAP providers (enterprise only; bind passwords are masked)
 * resp-200: array<{id:integer!, name:string!, enabled:boolean!, serverUrl:string!, baseDn:string!}>
 * resp-200-example: [{"id":1,"name":"Corporate LDAP","enabled":true,"serverUrl":"ldaps://ldap.example.com:636","baseDn":"dc=example,dc=com"}]
 * resp-401: Authentication required (auth is enabled and the caller is not an authenticated admin)
 * resp-403: Enterprise license required
 * resp-500: Failed to read the LDAP configurations
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Allow access when auth is disabled (setup mode) or when user is admin
	if (auth.authEnabled && (!auth.isAuthenticated || !auth.isAdmin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	try {
		const configs = await getLdapConfigs();
		// Don't return passwords
		const sanitized = configs.map(config => ({
			...config,
			bindPassword: config.bindPassword ? '********' : undefined
		}));
		return json(sanitized);
	} catch (error) {
		console.error('Failed to get LDAP configs:', error);
		return json({ error: 'Failed to get LDAP configurations' }, { status: 500 });
	}
};

// POST /api/auth/ldap - Create a new LDAP configuration
/**
 * @openapi
 * summary: Create a new LDAP provider configuration (enterprise only)
 * body: {name:string!, serverUrl:string!, baseDn:string!, enabled:boolean, bindDn:string, bindPassword:string, userFilter:string, usernameAttribute:string, emailAttribute:string, displayNameAttribute:string, groupBaseDn:string, groupFilter:string, adminGroup:string, roleMappings:{}, tlsEnabled:boolean, tlsCa:string}
 * body-example: {"name":"Corporate LDAP","serverUrl":"ldaps://ldap.example.com:636","baseDn":"dc=example,dc=com","bindDn":"cn=admin,dc=example,dc=com","bindPassword":"***","enabled":true,"tlsEnabled":true}
 * resp-201: {id:integer!, name:string!, enabled:boolean!, serverUrl:string!, baseDn:string!}
 * resp-201-desc: LDAP configuration created (bindPassword is masked in the response)
 * resp-400: Name, server URL, and base DN are required
 * resp-401: Authentication required (auth is enabled and the caller is not an authenticated admin)
 * resp-403: Enterprise license required
 * resp-500: Failed to create the LDAP configuration
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	// Allow access when auth is disabled (setup mode) or when user is admin
	if (auth.authEnabled && (!auth.isAuthenticated || !auth.isAdmin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	try {
		const data = await request.json();

		// Validate required fields
		if (!data.name || !data.serverUrl || !data.baseDn) {
			return json({ error: 'Name, server URL, and base DN are required' }, { status: 400 });
		}

		const config = await createLdapConfig({
			name: data.name,
			enabled: data.enabled ?? false,
			serverUrl: data.serverUrl,
			bindDn: data.bindDn || undefined,
			bindPassword: data.bindPassword || undefined,
			baseDn: data.baseDn,
			userFilter: data.userFilter || '(uid={{username}})',
			usernameAttribute: data.usernameAttribute || 'uid',
			emailAttribute: data.emailAttribute || 'mail',
			displayNameAttribute: data.displayNameAttribute || 'cn',
			groupBaseDn: data.groupBaseDn || undefined,
			groupFilter: data.groupFilter || undefined,
			adminGroup: data.adminGroup || undefined,
			roleMappings: data.roleMappings || undefined,
			tlsEnabled: data.tlsEnabled ?? false,
			tlsCa: data.tlsCa || undefined
		});

		// Audit log
		await auditLdapConfig(event, 'create', config.id, config.name);

		return json({
			...config,
			bindPassword: config.bindPassword ? '********' : undefined
		}, { status: 201 });
	} catch (error) {
		console.error('Failed to create LDAP config:', error);
		return json({ error: 'Failed to create LDAP configuration' }, { status: 500 });
	}
};
