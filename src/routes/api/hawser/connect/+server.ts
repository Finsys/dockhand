/**
 * Hawser Edge WebSocket Connect Endpoint
 *
 * This endpoint handles WebSocket connections from Hawser agents running in Edge mode.
 * In development: WebSocket is handled by ws.WebSocketServer in vite.config.ts on port 5174
 * In production: WebSocket is handled by the server wrapper in server.ts
 *
 * The HTTP GET endpoint returns connection info for clients.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isEdgeConnected, getAllEdgeConnections } from '$lib/server/hawser';
import { authorize } from '$lib/server/authorize';

/**
 * GET /api/hawser/connect
 * Returns status of the Hawser Edge connection endpoint
 * This is used for health checks and debugging
 */
/**
 * @openapi
 * summary: Report the Hawser Edge WebSocket endpoint status and list currently connected agents
 * description: Requires environments:view. Each entry names a remote host and the Docker and agent versions running on it, so the listing is limited to the environments the caller can reach.
 * resp-200: {status:string!, message:string!, protocol:string!, activeConnections:integer!, connections:array<{environmentId:integer!, agentId:string, agentName:string, agentVersion:string, dockerVersion:string, hostname:string, capabilities:array<string>, connectedAt:string, lastHeartbeat:string}>!}
 * resp-200-example: {"status":"ready","message":"Hawser Edge WebSocket endpoint. Connect via WebSocket.","protocol":"wss://<host>/api/hawser/connect","activeConnections":0,"connections":[]}
 * resp-401: Not authenticated
 * resp-403: Permission denied (missing environments:view)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}
	// An inventory of the remote machines this instance manages, down to the Docker
	// build running on each, so it follows the environments it describes.
	const denied = await auth.requirePermission('environments', 'view');
	if (denied) return denied;

	// null means every environment is the caller's to see.
	const reachable = await auth.getAccessibleEnvironmentIds();

	const connections = getAllEdgeConnections();
	const connectionList = Array.from(connections.entries())
		.filter(([envId]) => reachable === null || reachable.includes(envId))
		.map(([envId, conn]) => ({
			environmentId: envId,
			agentId: conn.agentId,
			agentName: conn.agentName,
			agentVersion: conn.agentVersion,
			dockerVersion: conn.dockerVersion,
			hostname: conn.hostname,
			capabilities: conn.capabilities,
			connectedAt: conn.connectedAt.toISOString(),
			lastHeartbeat: new Date(conn.lastHeartbeat).toISOString()
		}));

	return json({
		status: 'ready',
		message: 'Hawser Edge WebSocket endpoint. Connect via WebSocket.',
		protocol: 'wss://<host>/api/hawser/connect',
		activeConnections: connectionList.length,
		connections: connectionList
	});
};

/**
 * POST /api/hawser/connect
 * This is a fallback for non-WebSocket clients.
 * Returns instructions for connecting via WebSocket.
 */
/**
 * @openapi
 * summary: Fallback for non-WebSocket clients; always advises upgrading to a WebSocket connection
 * resp-426: This endpoint requires a WebSocket upgrade (ws:// or wss://)
 * resp-426-example: {"error":"WebSocket required","message":"This endpoint requires a WebSocket connection. Use the ws:// or wss:// protocol.","instructions":["1. Generate a token in Settings","2. Configure the Hawser agent","3. The agent connects automatically"]}
 */
export const POST: RequestHandler = async () => {
	return json(
		{
			error: 'WebSocket required',
			message: 'This endpoint requires a WebSocket connection. Use the ws:// or wss:// protocol.',
			instructions: [
				'1. Generate a token in Settings > Environments > [Environment] > Hawser',
				'2. Configure your Hawser agent with DOCKHAND_SERVER_URL and TOKEN',
				'3. The agent will connect automatically'
			]
		},
		{ status: 426 }
	); // 426 Upgrade Required
};
