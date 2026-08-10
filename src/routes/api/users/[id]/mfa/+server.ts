import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	validateSession,
	generateMfaSetup,
	verifyAndEnableMfa,
	disableMfa
} from '$lib/server/auth';
import { auditUser } from '$lib/server/audit';
import { getUser } from '$lib/server/db';

// POST /api/users/[id]/mfa - Setup MFA (generate QR code)
/**
 * @openapi
 * summary: Set up MFA for a user — without a body returns a new TOTP secret/QR; with action=verify enables MFA and returns backup codes
 * path: id:integer! Numeric id of the user (from GET /api/users)
 * body: {action:string, token:string}
 * body-example: {"action":"verify","token":"123456"}
 * resp-200: {secret:string, qrDataUrl:string, success:boolean, message:string, backupCodes:array<string>}
 * resp-200-desc: Setup response ({secret, qrDataUrl}); or, for action=verify, {success, message, backupCodes}
 * resp-400: User id is required, MFA token missing, or the MFA code was invalid
 * resp-403: Permission denied (may only manage own MFA unless admin)
 * resp-404: User not found
 * resp-500: Failed to set up MFA
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const currentUser = await validateSession(cookies);

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	const userId = parseInt(params.id);

	// Users can only setup MFA for themselves, or admins can do it for others
	if (!currentUser || (currentUser.id !== userId && !currentUser.isAdmin)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json().catch(() => ({}));

		// Check if this is a verification request
		if (body.action === 'verify') {
			if (!body.token) {
				return json({ error: 'MFA token is required' }, { status: 400 });
			}

			const result = await verifyAndEnableMfa(userId, body.token);
			if (!result.success) {
				return json({ error: 'Invalid MFA code' }, { status: 400 });
			}

			// Audit log - MFA enabled
			const targetUser = await getUser(userId);
			if (targetUser) {
				await auditUser(event, 'update', userId, targetUser.username, {
					mfaEnabled: true,
					enabledBy: currentUser?.id === userId ? 'self' : currentUser?.username
				});
			}

			return json({
				success: true,
				message: 'MFA enabled successfully',
				backupCodes: result.backupCodes
			});
		}

		// Generate new MFA setup
		const setup = await generateMfaSetup(userId);
		if (!setup) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		return json({
			secret: setup.secret,
			qrDataUrl: setup.qrDataUrl
		});
	} catch (error) {
		console.error('MFA setup error:', error);
		return json({ error: 'Failed to setup MFA' }, { status: 500 });
	}
};

// DELETE /api/users/[id]/mfa - Disable MFA
/**
 * @openapi
 * summary: Disable MFA for a user (self or admin)
 * path: id:integer! Numeric id of the user (from GET /api/users)
 * resp-200: {success:boolean!, message:string!}
 * resp-400: User id is required
 * resp-403: Permission denied (may only manage own MFA unless admin)
 * resp-404: User not found
 * resp-500: Failed to disable MFA
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const currentUser = await validateSession(cookies);

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	const userId = parseInt(params.id);

	// Users can only disable their own MFA, or admins can do it for others
	if (!currentUser || (currentUser.id !== userId && !currentUser.isAdmin)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Get user info before disabling for audit
		const targetUser = await getUser(userId);
		if (!targetUser) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		const success = await disableMfa(userId);
		if (!success) {
			return json({ error: 'Failed to disable MFA' }, { status: 500 });
		}

		// Audit log - MFA disabled
		await auditUser(event, 'update', userId, targetUser.username, {
			mfaDisabled: true,
			disabledBy: currentUser?.id === userId ? 'self' : currentUser?.username
		});

		return json({ success: true, message: 'MFA disabled successfully' });
	} catch (error) {
		console.error('MFA disable error:', error);
		return json({ error: 'Failed to disable MFA' }, { status: 500 });
	}
};
