import { validateSessionById, isAuthEnabled, SESSION_COOKIE } from './auth';
import { validateApiToken } from './api-tokens';
import { isEnterprise } from './license';
import { userHasAdminRole, userCanAccessEnvironment } from './db';
import { parseCookieHeader } from '$lib/utils/cookie-parse';

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

export async function authenticateWsUpgrade(
	headers: LowercasedHeaders
): Promise<WsUpgradeAuth | null> {
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

declare global {
	// eslint-disable-next-line no-var
	var __authenticateWsUpgrade:
		| ((headers: LowercasedHeaders) => Promise<WsUpgradeAuth | null>)
		| undefined;
	// eslint-disable-next-line no-var
	var __canAccessEnvForUser:
		| ((auth: WsUpgradeAuth, envId: number | undefined | null) => Promise<boolean>)
		| undefined;
}

globalThis.__authenticateWsUpgrade = authenticateWsUpgrade;
globalThis.__canAccessEnvForUser = canAccessEnvForUser;
