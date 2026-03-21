import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const privacyPath = join(process.cwd(), 'PRIVACY.txt');
		const content = readFileSync(privacyPath, 'utf-8');

		// Return as plain text if requested
		if (url.searchParams.get('format') === 'text') {
			return text(content, {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		return json({ content });
	} catch (error) {
		console.error('Failed to read PRIVACY.txt:', error);
		return json({ error: 'Privacy policy file not found' }, { status: 404 });
	}
};
