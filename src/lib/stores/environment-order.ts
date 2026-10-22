/**
 * The order environments are listed in, as the user arranged them.
 *
 * Environments the caller cannot see never reach the client, and each user has
 * their own order, so reordering can never disturb anyone else's list.
 */
import { createIdOrderStore } from './id-order-store';

export const environmentOrder = createIdOrderStore({
	storageKey: 'dockhand-environment-order',
	endpoint: '/api/preferences/environment-order'
});
