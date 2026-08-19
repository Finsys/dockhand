import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Liveness probe — always returns 200 when the SvelteKit process is up
 * resp-200: {status:string!, timestamp:string!}
 * resp-200-example: {"status":"ok","timestamp":"2027-01-01T12:00:00.000Z"}
 */
export const GET: RequestHandler = async () => {
	return json({ status: 'ok', timestamp: new Date().toISOString() });
};
