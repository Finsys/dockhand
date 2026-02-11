/**
 * Audit Logging Helper
 *
 * Provides easy-to-use functions for logging audit events from API endpoints.
 * This is an Enterprise-only feature.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { isEnterprise } from './license';
import { logAuditEvent, type AuditAction, type AuditEntityType, type AuditLogCreateData } from './db';
import { authorize } from './authorize';

export interface AuditContext {
	userId?: number | null;
	username: string;
	ipAddress?: string | null;
	userAgent?: string | null;
}

/**
 * Extract audit context from a request event
 */
export async function getAuditContext(event: RequestEvent): Promise<AuditContext> {
	const auth = await authorize(event.cookies);

	// Get IP address from various headers (proxied requests)
	const forwardedFor = event.request.headers.get('x-forwarded-for');
	const realIp = event.request.headers.get('x-real-ip');
	let ipAddress = forwardedFor?.split(',')[0]?.trim() || realIp || event.getClientAddress?.() || null;

	// Convert IPv6 loopback to more readable format
	if (ipAddress === '::1' || ipAddress === '::ffff:127.0.0.1') {
		ipAddress = '127.0.0.1';
	} else if (ipAddress?.startsWith('::ffff:')) {
		// Strip IPv6 prefix from IPv4-mapped addresses
		ipAddress = ipAddress.substring(7);
	}

	// Get user agent
	const userAgent = event.request.headers.get('user-agent') || null;

	return {
		userId: auth.user?.id ?? null,
		username: auth.user?.username ?? 'anonymous',
		ipAddress,
		userAgent
	};
}

/**
 * Log an audit event (only logs if Enterprise license is active)
 */
export async function audit(
	event: RequestEvent,
	action: AuditAction,
	entityType: AuditEntityType,
	options: {
		entityId?: string | null;
		entityName?: string | null;
		environmentId?: number | null;
		description?: string | null;
		details?: any | null;
	} = {}
): Promise<void> {
	// Only log if enterprise
	if (!(await isEnterprise())) return;

	const ctx = await getAuditContext(event);

	const data: AuditLogCreateData = {
		userId: ctx.userId,
		username: ctx.username,
		action,
		entityType: entityType,
		entityId: options.entityId ?? null,
		entityName: options.entityName ?? null,
		environmentId: options.environmentId ?? null,
		description: options.description ?? null,
		details: options.details ?? null,
		ipAddress: ctx.ipAddress ?? null,
		userAgent: ctx.userAgent ?? null
	};

	try {
		await logAuditEvent(data);
	} catch (error) {
		// Don't let audit logging errors break the main operation
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Audit] Failed to log event:', errorMsg);
	}
}

/**
 * Helper for container actions
 */
export async function auditContainer(
	event: RequestEvent,
	action: AuditAction,
	containerId: string,
	containerName: string,
	environmentId?: number | null,
	details?: any
): Promise<void> {
	await audit(event, action, 'container', {
		entityId: containerId,
		entityName: containerName,
		environmentId,
		description: `Container ${containerName} ${action}`,
		details
	});
}

/**
 * Helper for image actions
 */
export async function auditImage(
	event: RequestEvent,
	action: AuditAction,
	imageId: string,
	imageName: string,
	environmentId?: number | null,
	details?: any
): Promise<void> {
	await audit(event, action, 'image', {
		entityId: imageId,
		entityName: imageName,
		environmentId,
		description: `Image ${imageName} ${action}`,
		details
	});
}

/**
 * Helper for stack actions
 */
export async function auditStack(
	event: RequestEvent,
	action: AuditAction,
	stackName: string,
	environmentId?: number | null,
	details?: any
): Promise<void> {
	await audit(event, action, 'stack', {
		entityId: stackName,
		entityName: stackName,
		environmentId,
		description: `Stack ${stackName} ${action}`,
		details
	});
}

/**
 * Helper for volume actions
 */
export async function auditVolume(
	event: RequestEvent,
	action: AuditAction,
	volumeId: string,
	volumeName: string,
	environmentId?: number | null,
	details?: any
): Promise<void> {
	await audit(event, action, 'volume', {
		entityId: volumeId,
		entityName: volumeName,
		environmentId,
		description: `Volume ${volumeName} ${action}`,
		details
	});
}

/**
 * Helper for network actions
 */
export async function auditNetwork(
	event: RequestEvent,
	action: AuditAction,
	networkId: string,
	networkName: string,
	environmentId?: number | null,
	details?: any
): Promise<void> {
	await audit(event, action, 'network', {
		entityId: networkId,
		entityName: networkName,
		environmentId,
		description: `Network ${networkName} ${action}`,
		details
	});
}

/**
 * Helper for user actions
 */
export async function auditUser(
	event: RequestEvent,
	action: AuditAction,
	userId: number,
	username: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'user', {
		entityId: String(userId),
		entityName: username,
		description: `User ${username} ${action}`,
		details
	});
}

/**
 * Helper for role actions
 */
export async function auditRole(
	event: RequestEvent,
	action: AuditAction,
	roleId: number,
	roleName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'role', {
		entityId: String(roleId),
		entityName: roleName,
		description: `Role ${roleName} ${action}`,
		details
	});
}

/**
 * Helper for settings actions
 */
export async function auditSettings(
	event: RequestEvent,
	action: AuditAction,
	settingName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'settings', {
		entityId: settingName,
		entityName: settingName,
		description: `Settings ${settingName} ${action}`,
		details
	});
}

/**
 * Helper for environment actions
 */
export async function auditEnvironment(
	event: RequestEvent,
	action: AuditAction,
	environmentId: number,
	environmentName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'environment', {
		entityId: String(environmentId),
		entityName: environmentName,
		environmentId,
		description: `Environment ${environmentName} ${action}`,
		details
	});
}

/**
 * Helper for registry actions
 */
export async function auditRegistry(
	event: RequestEvent,
	action: AuditAction,
	registryId: number,
	registryName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'registry', {
		entityId: String(registryId),
		entityName: registryName,
		description: `Registry ${registryName} ${action}`,
		details
	});
}

/**
 * Helper for git repository actions
 */
export async function auditGitRepository(
	event: RequestEvent,
	action: AuditAction,
	repositoryId: number,
	repositoryName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'git_repository', {
		entityId: String(repositoryId),
		entityName: repositoryName,
		description: `Git repository ${repositoryName} ${action}`,
		details
	});
}

/**
 * Helper for git credential actions
 */
export async function auditGitCredential(
	event: RequestEvent,
	action: AuditAction,
	credentialId: number,
	credentialName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'git_credential', {
		entityId: String(credentialId),
		entityName: credentialName,
		description: `Git credential ${credentialName} ${action}`,
		details
	});
}

/**
 * Helper for config set actions
 */
export async function auditConfigSet(
	event: RequestEvent,
	action: AuditAction,
	configSetId: number,
	configSetName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'config_set', {
		entityId: String(configSetId),
		entityName: configSetName,
		description: `Config set ${configSetName} ${action}`,
		details
	});
}

/**
 * Helper for notification channel actions
 */
export async function auditNotification(
	event: RequestEvent,
	action: AuditAction,
	notificationId: number,
	notificationName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'notification', {
		entityId: String(notificationId),
		entityName: notificationName,
		description: `Notification channel ${notificationName} ${action}`,
		details
	});
}

/**
 * Helper for OIDC provider actions
 */
export async function auditOidcProvider(
	event: RequestEvent,
	action: AuditAction,
	providerId: number,
	providerName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'oidc_provider', {
		entityId: String(providerId),
		entityName: providerName,
		description: `OIDC provider ${providerName} ${action}`,
		details
	});
}

/**
 * Helper for LDAP config actions
 */
export async function auditLdapConfig(
	event: RequestEvent,
	action: AuditAction,
	configId: number,
	configName: string,
	details?: any
): Promise<void> {
	await audit(event, action, 'ldap_config', {
		entityId: String(configId),
		entityName: configName,
		description: `LDAP config ${configName} ${action}`,
		details
	});
}

/**
 * Helper for git stack actions
 */
export async function auditGitStack(
	event: RequestEvent,
	action: AuditAction,
	stackId: number,
	stackName: string,
	environmentId?: number | null,
	details?: any
): Promise<void> {
	await audit(event, action, 'git_stack', {
		entityId: String(stackId),
		entityName: stackName,
		environmentId,
		description: `Git stack ${stackName} ${action}`,
		details
	});
}

/**
 * Helper for auth actions (login/logout)
 */
export async function auditAuth(
	event: RequestEvent,
	action: 'login' | 'logout',
	username: string,
	details?: any
): Promise<void> {
	// For login/logout, we want to log even without a session
	if (!(await isEnterprise())) return;

	const forwardedFor = event.request.headers.get('x-forwarded-for');
	const realIp = event.request.headers.get('x-real-ip');
	let ipAddress = forwardedFor?.split(',')[0]?.trim() || realIp || event.getClientAddress?.() || null;

	// Convert IPv6 loopback to more readable format
	if (ipAddress === '::1' || ipAddress === '::ffff:127.0.0.1') {
		ipAddress = '127.0.0.1';
	} else if (ipAddress?.startsWith('::ffff:')) {
		ipAddress = ipAddress.substring(7);
	}

	const userAgent = event.request.headers.get('user-agent') || null;

	const data: AuditLogCreateData = {
		userId: null, // Will be set from details if available
		username,
		action,
		entityType: 'user',
		entityId: null,
		entityName: username,
		environmentId: null,
		description: `User ${username} ${action}`,
		details,
		ipAddress: ipAddress,
		userAgent: userAgent
	};

	try {
		await logAuditEvent(data);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[Audit] Failed to log event:', errorMsg);
	}
}
