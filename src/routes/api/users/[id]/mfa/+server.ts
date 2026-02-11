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
