/**
 * Validation helpers to ensure each Dockhand environment points to a distinct
 * Docker daemon, regardless of connection type (socket, direct, Hawser).
 */

import { existsSync, realpathSync } from 'fs';
import { getEnvironments, type Environment } from '$lib/server/db';
import {
	getDockerDaemonId,
	getDockerDaemonIdFromConfig
} from '$lib/server/docker';
import { cleanPem } from '$lib/utils/pem';
import {
	areSocketConfigsEquivalent as areSocketConfigsEquivalentPure,
	normalizeSocketPath as normalizeSocketPathPure,
	hasConnectionFieldChanges as hasConnectionFieldChangesPure,
	allowDuplicateDockerEnvironmentsFromEnv,
	type EnvironmentConnectionInput
} from '$lib/utils/docker-environment-uniqueness';

export type { EnvironmentConnectionInput } from '$lib/utils/docker-environment-uniqueness';

export type DuplicateDockerValidationResult =
	| { ok: true }
	| { ok: false; error: string };

const DUPLICATE_ERROR =
	'This environment connects to the same Docker instance as "{name}". Each environment must point to a distinct Docker daemon.';

function isDuplicateDockerValidationEnabled(): boolean {
	return !allowDuplicateDockerEnvironmentsFromEnv(process.env.DOCKHAND_ALLOW_DUPLICATE_ENVS);
}

function duplicateError(environmentName: string): DuplicateDockerValidationResult {
	return {
		ok: false,
		error: DUPLICATE_ERROR.replace('{name}', environmentName)
	};
}

export function normalizeSocketPath(socketPath: string): string {
	return normalizeSocketPathPure(socketPath, existsSync, realpathSync);
}

export function areSocketConfigsEquivalent(
	a: EnvironmentConnectionInput,
	b: EnvironmentConnectionInput
): boolean {
	return areSocketConfigsEquivalentPure(a, b, existsSync, realpathSync);
}

export function connectionInputFromEnvironment(env: Environment): EnvironmentConnectionInput {
	return {
		connectionType: (env.connectionType || 'socket') as EnvironmentConnectionInput['connectionType'],
		socketPath: env.socketPath,
		host: env.host,
		port: env.port,
		protocol: env.protocol,
		tlsCa: env.tlsCa,
		tlsCert: env.tlsCert,
		tlsKey: env.tlsKey,
		tlsSkipVerify: env.tlsSkipVerify,
		hawserToken: env.hawserToken
	};
}

export function connectionInputFromRequest(data: {
	connectionType?: string | null;
	socketPath?: string | null;
	host?: string | null;
	port?: number | null;
	protocol?: string | null;
	tlsCa?: string | null;
	tlsCert?: string | null;
	tlsKey?: string | null;
	tlsSkipVerify?: boolean | null;
	hawserToken?: string | null;
}): EnvironmentConnectionInput {
	return {
		connectionType: (data.connectionType || 'socket') as EnvironmentConnectionInput['connectionType'],
		socketPath: data.socketPath,
		host: data.host,
		port: data.port,
		protocol: data.protocol,
		tlsCa: data.tlsCa,
		tlsCert: data.tlsCert,
		tlsKey: data.tlsKey,
		tlsSkipVerify: data.tlsSkipVerify,
		hawserToken: data.hawserToken
	};
}

export function mergeConnectionInput(
	oldEnv: Environment,
	data: Record<string, unknown>
): EnvironmentConnectionInput {
	return {
		connectionType: (data.connectionType ?? oldEnv.connectionType ?? 'socket') as EnvironmentConnectionInput['connectionType'],
		socketPath: (data.socketPath ?? oldEnv.socketPath) as string | null | undefined,
		host: (data.host ?? oldEnv.host) as string | null | undefined,
		port: (data.port ?? oldEnv.port) as number | null | undefined,
		protocol: (data.protocol ?? oldEnv.protocol) as string | null | undefined,
		tlsCa: data.tlsCa !== undefined ? cleanPem(data.tlsCa as string) : oldEnv.tlsCa,
		tlsCert: data.tlsCert !== undefined ? cleanPem(data.tlsCert as string) : oldEnv.tlsCert,
		tlsKey: data.tlsKey !== undefined ? cleanPem(data.tlsKey as string) : oldEnv.tlsKey,
		tlsSkipVerify: (data.tlsSkipVerify ?? oldEnv.tlsSkipVerify) as boolean | null | undefined,
		hawserToken: (data.hawserToken ?? oldEnv.hawserToken) as string | null | undefined
	};
}

export function hasConnectionFieldChanges(oldEnv: Environment, data: Record<string, unknown>): boolean {
	return hasConnectionFieldChangesPure(oldEnv as Record<string, unknown>, data, cleanPem);
}

async function findDuplicateByDaemonId(
	candidates: Environment[],
	newDockerId: string
): Promise<DuplicateDockerValidationResult> {
	const idResults = await Promise.allSettled(
		candidates.map(async (env) => ({
			env,
			id: await getDockerDaemonId(env.id)
		}))
	);

	for (const result of idResults) {
		if (result.status === 'fulfilled' && result.value.id === newDockerId) {
			return duplicateError(result.value.env.name);
		}
	}

	return { ok: true };
}

/**
 * Check whether a connection configuration would duplicate an existing environment.
 * Compares resolved Unix socket paths and Docker daemon IDs from /info.
 */
export async function findDuplicateDockerEnvironment(
	config: EnvironmentConnectionInput,
	options?: { excludeEnvId?: number; envIdForEdge?: number }
): Promise<DuplicateDockerValidationResult> {
	if (!isDuplicateDockerValidationEnabled()) {
		return { ok: true };
	}

	const excludeEnvId = options?.excludeEnvId;
	const connectionType = config.connectionType || 'socket';

	let newDockerId: string | null = null;
	if (connectionType === 'hawser-edge' && options?.envIdForEdge) {
		newDockerId = await getDockerDaemonId(options.envIdForEdge);
	} else if (connectionType !== 'hawser-edge') {
		newDockerId = await getDockerDaemonIdFromConfig(config);
	}

	const allEnvs = await getEnvironments();
	const candidates = allEnvs.filter(
		(e) => excludeEnvId === undefined || e.id !== excludeEnvId
	);

	for (const existing of candidates) {
		if (areSocketConfigsEquivalent(config, connectionInputFromEnvironment(existing))) {
			return duplicateError(existing.name);
		}
	}

	if (!newDockerId) {
		return { ok: true };
	}

	return findDuplicateByDaemonId(candidates, newDockerId);
}

/**
 * Validate a Hawser edge agent after it connects. Rejects agents that proxy
 * to a Docker daemon already represented by another environment.
 */
export async function validateEdgeAgentDockerUniqueness(
	environmentId: number
): Promise<DuplicateDockerValidationResult> {
	if (!isDuplicateDockerValidationEnabled()) {
		return { ok: true };
	}

	const allEnvs = await getEnvironments();
	const env = allEnvs.find((e) => e.id === environmentId);
	if (!env) return { ok: true };

	const dockerId = await getDockerDaemonId(environmentId);
	if (!dockerId) return { ok: true };

	const others = allEnvs.filter((e) => e.id !== environmentId);
	return findDuplicateByDaemonId(others, dockerId);
}
