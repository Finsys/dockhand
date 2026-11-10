import { json } from '@sveltejs/kit';
import type { AuthorizationContext } from '../authorize';
import type { NotificationDelivery } from '$lib/utils/notification-retries';

export async function requireNotificationDeliveryAccess(auth: AuthorizationContext,
	row: NotificationDelivery, action: 'view' | 'edit'): Promise<Response | null> {
	if (!auth.authEnabled) return null;
	if (!auth.isAuthenticated) return json({ error: 'Authentication required' }, { status: 401 });
	if (!await auth.can('notifications', action, row.environmentId ?? undefined)) return json({ error: 'Permission denied' }, { status: 403 });
	if (row.environmentId !== null) {
		if (!await auth.canAccessEnvironment(row.environmentId)) return json({ error: 'Permission denied' }, { status: 403 });
	} else if ((await auth.getAccessibleEnvironmentIds()) !== null) {
		// System/broadcast deliveries must not leak across environment-scoped roles.
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return null;
}
