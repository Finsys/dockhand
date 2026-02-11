import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitCredentials,
	createGitCredential,
	type GitAuthType
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditGitCredential } from '$lib/server/audit';

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const credentials = await getGitCredentials();
		// Don't expose sensitive data in list view
		const sanitized = credentials.map(cred => ({
			id: cred.id,
			name: cred.name,
			authType: cred.authType,
			username: cred.username,
			hasPassword: !!cred.password,
			hasSshKey: !!cred.sshPrivateKey,
			createdAt: cred.createdAt,
			updatedAt: cred.updatedAt
		}));
		return json(sanitized);
	} catch (error) {
		console.error('Failed to get git credentials:', error);
		return json({ error: 'Failed to get git credentials' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		if (!data.name || typeof data.name !== 'string') {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		const authType = (data.authType || 'none') as GitAuthType;
		if (!['none', 'password', 'ssh'].includes(authType)) {
			return json({ error: 'Invalid auth type' }, { status: 400 });
		}

		if (authType === 'password' && !data.password) {
			return json({ error: 'Password is required for password authentication' }, { status: 400 });
		}

		if (authType === 'ssh' && !data.sshPrivateKey) {
			return json({ error: 'SSH private key is required for SSH authentication' }, { status: 400 });
		}

		const credential = await createGitCredential({
			name: data.name,
			authType,
			username: data.username,
			password: data.password,
			sshPrivateKey: data.sshPrivateKey,
			sshPassphrase: data.sshPassphrase
		});

		// Audit log
		await auditGitCredential(event, 'create', credential.id, credential.name);

		return json({
			id: credential.id,
			name: credential.name,
			authType: credential.authType,
			username: credential.username,
			hasPassword: !!credential.password,
			hasSshKey: !!credential.sshPrivateKey,
			createdAt: credential.createdAt,
			updatedAt: credential.updatedAt
		});
	} catch (error: any) {
		console.error('Failed to create git credential:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A credential with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create git credential' }, { status: 500 });
	}
};
