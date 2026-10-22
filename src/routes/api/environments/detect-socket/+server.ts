import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { authorize } from '$lib/server/authorize';

interface DetectedSocket {
	path: string;
	name: string;
	exists: boolean;
}

/**
 * Detect available Docker sockets on the system
 *
 * @openapi
 * summary: Detect common Docker/Podman socket paths that exist on the Dockhand host
 * resp-200: {sockets:array<{path:string!, name:string!, exists:boolean!}>!, homedir:string!}
 * resp-200-example: {"sockets":[{"path":"/var/run/docker.sock","name":"Docker (default)","exists":true}],"homedir":"/home/dockhand"}
 * resp-403: Permission denied (needs environments:create or environments:edit)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	// Reports which container runtime this host runs and the account it runs as. The
	// environment form is the only caller, and it opens under either permission, so
	// requiring just one of them would refuse half the people who can reach it.
	const auth = await authorize(cookies);
	if (
		auth.authEnabled &&
		!(await auth.can('environments', 'create')) &&
		!(await auth.can('environments', 'edit'))
	) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const home = homedir();

	// Common socket paths to check
	const socketPaths: { path: string; name: string }[] = [
		{ path: '/var/run/docker.sock', name: 'Docker (default)' },
		{ path: `${home}/.docker/run/docker.sock`, name: 'Docker Desktop' },
		{ path: `${home}/.orbstack/run/docker.sock`, name: 'OrbStack' },
		{ path: '/run/docker.sock', name: 'Docker (alternate)' },
		{ path: `${home}/.colima/default/docker.sock`, name: 'Colima' },
		{ path: `${home}/.rd/docker.sock`, name: 'Rancher Desktop' },
		{ path: '/run/user/1000/podman/podman.sock', name: 'Podman (user 1000)' },
		{ path: `${home}/.local/share/containers/podman/machine/podman.sock`, name: 'Podman Machine' },
	];

	const detected: DetectedSocket[] = [];

	for (const socket of socketPaths) {
		if (existsSync(socket.path)) {
			detected.push({
				path: socket.path,
				name: socket.name,
				exists: true
			});
		}
	}

	return json({
		sockets: detected,
		homedir: home
	});
};
