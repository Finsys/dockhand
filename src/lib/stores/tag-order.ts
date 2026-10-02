/**
 * The order tags are listed and grouped in, as the user arranged them.
 *
 * The tag catalogue itself is shared across the instance, but this order is each
 * user's own - so arranging them never changes what a colleague sees.
 */
import { createIdOrderStore } from './id-order-store';

export const tagOrder = createIdOrderStore({
	storageKey: 'dockhand-tag-order',
	endpoint: '/api/preferences/tag-order'
});
