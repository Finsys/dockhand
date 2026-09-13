import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getGitCredential,
	updateGitCredential,
	deleteGitCredential,
	type GitAuthType
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditGitCredential } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

/**
 * @openapi
 * summary: Get a single git credential by ID with secrets stripped (only hasPassword/hasSshKey flags returned)
 * path: id:integer! Git credential ID (from GET /api/git/credentials)
 * resp-200: {id:integer!, name:string!, authType:string!, username:string, hasPassword:boolean!, hasSshKey:boolean!, createdAt:string, updatedAt:string}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks the git:view permission
 * resp-404: No credential exists with that ID
 * resp-500: Failed to read the git credential
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid credential ID' }, { status: 400 });
		}

		const credential = await getGitCredential(id);
		if (!credential) {
			return json({ error: 'Credential not found' }, { status: 404 });
		}

		// Don't expose sensitive data
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
	} catch (error) {
		console.error('Failed to get git credential:', error);
		return json({ error: 'Failed to get git credential' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Update a git credential and return it with secrets stripped
 * path: id:integer! Git credential ID (from GET /api/git/credentials)
 * body: {name:string, authType:string, username:string, password:string, sshPrivateKey:string, sshPassphrase:string}
 * body-example: {"name":"github-deploy","authType":"password","username":"git","password":"***"}
 * resp-200: {id:integer!, name:string!, authType:string!, username:string, hasPassword:boolean!, hasSshKey:boolean!, createdAt:string, updatedAt:string}
 * resp-400: Invalid id, invalid authType, or a duplicate credential name
 * resp-403: Caller lacks the git:edit permission
 * resp-404: No credential exists with that ID
 * resp-500: The update failed or the credential could not be persisted
 */
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid credential ID' }, { status: 400 });
		}

		const existing = await getGitCredential(id);
		if (!existing) {
			return json({ error: 'Credential not found' }, { status: 404 });
		}

		const data = await request.json();

		if (data.authType && !['none', 'password', 'ssh'].includes(data.authType)) {
			return json({ error: 'Invalid auth type' }, { status: 400 });
		}

		const credential = await updateGitCredential(id, {
			name: data.name,
			authType: data.authType as GitAuthType,
			username: data.username,
			password: data.password,
			sshPrivateKey: data.sshPrivateKey,
			sshPassphrase: data.sshPassphrase
		});

		if (!credential) {
			return json({ error: 'Failed to update credential' }, { status: 500 });
		}

		// Compute diff for audit (only non-sensitive fields)
		const diff = computeAuditDiff(
			{ name: existing.name, authType: existing.authType, username: existing.username },
			{ name: credential.name, authType: credential.authType, username: credential.username }
		);

		// Audit log
		await auditGitCredential(event, 'update', credential.id, credential.name, diff);

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
		console.error('Failed to update git credential:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A credential with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update git credential' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a git credential by ID
 * path: id:integer! Git credential ID (from GET /api/git/credentials)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks the git:delete permission
 * resp-404: No credential exists with that ID
 * resp-500: The deletion failed
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid credential ID' }, { status: 400 });
		}

		// Get credential name before deletion for audit log
		const credential = await getGitCredential(id);
		if (!credential) {
			return json({ error: 'Credential not found' }, { status: 404 });
		}

		const deleted = await deleteGitCredential(id);
		if (!deleted) {
			return json({ error: 'Failed to delete credential' }, { status: 500 });
		}

		// Audit log
		await auditGitCredential(event, 'delete', id, credential.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete git credential:', error);
		return json({ error: 'Failed to delete git credential' }, { status: 500 });
	}
};
