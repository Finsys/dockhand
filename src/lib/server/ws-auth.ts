import { validateSessionById, isAuthEnabled, SESSION_COOKIE, getUserPermissionsForEnvironment } from './auth';
import { validateApiToken } from './api-tokens';
import { isEnterprise } from './license';
import { userHasAdminRole, userCanAccessEnvironment } from './db';
import { parseCookieHeader } from '$lib/utils/cookie-parse';
import { canExecDecision } from './ws-exec-core';
import { isOwnContainer } from './own-container-guard';
import { isForbiddenCrossOriginUpgrade, parseTrustedOrigins, csrfOriginCheckDisabled } from './csrf-origin-core';

export interface WsUpgradeAuth {
	userId: number;
	username: string;
	isAdmin: boolean;
	authDisabled: boolean;
}

type LowercasedHeaders = Record<string, string | string[] | undefined>;

function pickHeader(headers: LowercasedHeaders, name: string): string | undefined {
	const v = headers[name];
	if (Array.isArray(v)) return v[0];
	return v;
}

const WS_TRUSTED_ORIGINS = parseTrustedOrigins(process.env.TRUSTED_ORIGINS, process.env.ORIGIN);
const WS_ORIGIN_CHECK_DISABLED = csrfOriginCheckDisabled(process.env.DISABLE_CSRF_ORIGIN_CHECK);

export async function authenticateWsUpgrade(
	headers: LowercasedHeaders
): Promise<WsUpgradeAuth | null> {
	// A terminal reached from a page on another origin would run with this browser's session,
	// or as admin while auth is off. The same origin rules as cross-site form posts apply.
	if (
		isForbiddenCrossOriginUpgrade({
			origin: pickHeader(headers, 'origin') ?? null,
			secFetchSite: pickHeader(headers, 'sec-fetch-site') ?? null,
			host: pickHeader(headers, 'host') ?? null,
			trustedOrigins: WS_TRUSTED_ORIGINS,
			disabled: WS_ORIGIN_CHECK_DISABLED
		})
	) {
		console.warn(
			`[WS] terminal refused: origin ${pickHeader(headers, 'origin')} does not match host ${pickHeader(headers, 'host')}; behind a proxy set ORIGIN or TRUSTED_ORIGINS`
		);
		return null;
	}

	const authEnabled = await isAuthEnabled();
	if (!authEnabled) {
		return { userId: -1, username: '__bootstrap__', isAdmin: true, authDisabled: true };
	}

	const cookieHeader = pickHeader(headers, 'cookie');
	const cookies = parseCookieHeader(cookieHeader);
	const sessionId = cookies[SESSION_COOKIE];

	if (sessionId) {
		const user = await validateSessionById(sessionId);
		if (user) {
			const enterprise = await isEnterprise();
			const isAdmin = enterprise ? await userHasAdminRole(user.id) : true;
			return { userId: user.id, username: user.username, isAdmin, authDisabled: false };
		}
	}

	const authHeader = pickHeader(headers, 'authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		const token = authHeader.slice(7).trim();
		const user = await validateApiToken(token);
		if (user) {
			const enterprise = await isEnterprise();
			const isAdmin = enterprise ? await userHasAdminRole(user.id) : true;
			return { userId: user.id, username: user.username, isAdmin, authDisabled: false };
		}
	}

	return null;
}

export async function canAccessEnvForUser(
	auth: WsUpgradeAuth,
	environmentId: number | undefined | null
): Promise<boolean> {
	if (auth.authDisabled) return true;
	if (auth.isAdmin) return true;
	const enterprise = await isEnterprise();
	if (!enterprise) return true;
	if (environmentId == null) {
		return false;
	}
	return userCanAccessEnvironment(auth.userId, environmentId);
}

/**
 * Whether the WS user may open a container exec/terminal session. Mirrors the
 * REST gate `auth.can('containers','exec',envId)`. Pure logic lives in
 * ws-exec-core; this binds the real enterprise + permission deps.
 */
export async function canExecForUser(
	auth: WsUpgradeAuth,
	environmentId: number | undefined | null
): Promise<boolean> {
	return canExecDecision(auth, environmentId, {
		isEnterprise,
		getPerms: getUserPermissionsForEnvironment
	});
}

/** Whether the WS user is refused a terminal on Dockhand's own container (non-admins). */
export async function refusesOwnContainerForUser(
	auth: WsUpgradeAuth,
	containerRef: string,
	environmentId: number | undefined | null
): Promise<boolean> {
	if (auth.authDisabled || auth.isAdmin) return false;
	return isOwnContainer(containerRef, environmentId ?? undefined);
}

declare global {
	// eslint-disable-next-line no-var
	var __authenticateWsUpgrade:
		| ((headers: LowercasedHeaders) => Promise<WsUpgradeAuth | null>)
		| undefined;
	// eslint-disable-next-line no-var
	var __canAccessEnvForUser:
		| ((auth: WsUpgradeAuth, envId: number | undefined | null) => Promise<boolean>)
		| undefined;
	// eslint-disable-next-line no-var
	var __canExecForUser:
		| ((auth: WsUpgradeAuth, envId: number | undefined | null) => Promise<boolean>)
		| undefined;
	// eslint-disable-next-line no-var
	var __refusesOwnContainerForUser:
		| ((auth: WsUpgradeAuth, containerRef: string, envId: number | undefined | null) => Promise<boolean>)
		| undefined;
}

globalThis.__authenticateWsUpgrade = authenticateWsUpgrade;
globalThis.__canAccessEnvForUser = canAccessEnvForUser;
globalThis.__canExecForUser = canExecForUser;
globalThis.__refusesOwnContainerForUser = refusesOwnContainerForUser;
