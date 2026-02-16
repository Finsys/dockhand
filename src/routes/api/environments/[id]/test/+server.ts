import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironment, updateEnvironment } from '$lib/server/db';
import { getDockerInfo, getHawserInfo } from '$lib/server/docker';
import { edgeConnections, isEdgeConnected } from '$lib/server/hawser';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const id = parseInt(params.id);
		const env = await getEnvironment(id);

		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		// Edge mode - check connection status immediately without blocking
		if (env.connectionType === 'hawser-edge') {
			const edgeConn = edgeConnections.get(id);
			const connected = isEdgeConnected(id);

			if (!connected) {
				console.log(`[Test] Edge environment ${id} (${env.name}) - agent not connected`);
				return json({
					success: false,
					error: 'Edge agent is not connected',
					isEdgeMode: true,
					hawser: env.hawserVersion ? {
						hawserVersion: env.hawserVersion,
						agentId: env.hawserAgentId,
						agentName: env.hawserAgentName
					} : null
				}, { status: 200 });
			}

			// Agent is connected - try to get Docker info with shorter timeout
			console.log(`[Test] Edge environment ${id} (${env.name}) - agent connected, testing Docker...`);
			try {
				const info = await getDockerInfo(env.id) as any;
				return json({
					success: true,
					info: {
						serverVersion: info.ServerVersion,
						containers: info.Containers,
						images: info.Images,
						name: info.Name
					},
					isEdgeMode: true,
					hawser: edgeConn ? {
						hawserVersion: edgeConn.agentVersion,
						agentId: edgeConn.agentId,
						agentName: edgeConn.agentName,
						hostname: edgeConn.hostname,
						dockerVersion: edgeConn.dockerVersion,
						capabilities: edgeConn.capabilities
					} : null
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Docker API call failed';
				console.error(`[Test] Edge environment ${id} Docker test failed:`, message);
				return json({
					success: false,
					error: message,
					isEdgeMode: true,
					hawser: edgeConn ? {
						hawserVersion: edgeConn.agentVersion,
						agentId: edgeConn.agentId,
						agentName: edgeConn.agentName
					} : null
				}, { status: 200 });
			}
		}

		// For Hawser Standard mode, fetch Docker info and Hawser info in parallel
		// (sequential calls can fail due to Bun TLS connection reuse issues)
		let info: any;
		let hawserInfo = null;
		if (env.connectionType === 'hawser-standard') {
			const [dockerResult, hawserResult] = await Promise.all([
				getDockerInfo(env.id),
				getHawserInfo(id)
			]);
			info = dockerResult;
			hawserInfo = hawserResult;
			if (hawserInfo?.hawserVersion) {
				await updateEnvironment(id, {
					hawserVersion: hawserInfo.hawserVersion,
					hawserAgentId: hawserInfo.agentId,
					hawserAgentName: hawserInfo.agentName,
					hawserLastSeen: new Date().toISOString()
				});
			}
		} else {
			info = await getDockerInfo(env.id);
		}

		return json({
			success: true,
			info: {
				serverVersion: info.ServerVersion,
				containers: info.Containers,
				images: info.Images,
				name: info.Name
			},
			hawser: hawserInfo
		});
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : 'Connection failed';
		console.error('Failed to test connection:', rawMessage);

		// Provide more helpful error messages for Hawser connections
		let message = rawMessage;
		if (rawMessage.includes('401') || rawMessage.toLowerCase().includes('unauthorized')) {
			message = 'Invalid token - check that the Hawser token matches';
		} else if (rawMessage.includes('403') || rawMessage.toLowerCase().includes('forbidden')) {
			message = 'Access forbidden - check token permissions';
		} else if (rawMessage.includes('ECONNREFUSED') || rawMessage.includes('Connection refused')) {
			message = 'Connection refused - is Hawser running?';
		} else if (rawMessage.includes('ETIMEDOUT') || rawMessage.includes('timeout') || rawMessage.includes('Timeout')) {
			message = 'Connection timed out - check host and port';
		} else if (rawMessage.includes('ENOTFOUND') || rawMessage.includes('getaddrinfo')) {
			message = 'Host not found - check the hostname';
		} else if (rawMessage.includes('EHOSTUNREACH')) {
			message = 'Host unreachable - check network connectivity';
		}

		return json({ success: false, error: message }, { status: 200 });
	}
};
