import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @openapi
 * summary: Return the bundled LICENSE.txt — as JSON by default, or as raw text/plain when format=text
 * query: format:string Set to "text" to return the raw license as text/plain instead of JSON
 * resp-200: {content:string!}
 * resp-200-desc: The license text (as {content} JSON, or raw text/plain when format=text)
 * resp-404: LICENSE.txt could not be found/read
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const licensePath = join(process.cwd(), 'LICENSE.txt');
		const content = readFileSync(licensePath, 'utf-8');

		// Return as plain text if requested
		if (url.searchParams.get('format') === 'text') {
			return text(content, {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		return json({ content });
	} catch (error) {
		console.error('Failed to read LICENSE.txt:', error);
		return json({ error: 'License file not found' }, { status: 404 });
	}
};
