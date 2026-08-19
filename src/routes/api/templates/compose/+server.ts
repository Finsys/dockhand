import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import type { TemplateItem } from '../+server';

function generateContainerCompose(template: TemplateItem): string {
	const name = template.title.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
	const lines: string[] = ['services:', `  ${name}:`];

	if (template.image) {
		lines.push(`    image: ${template.image}`);
	}

	if (template.restartPolicy) {
		lines.push(`    restart: ${template.restartPolicy}`);
	}

	if (template.network) {
		lines.push(`    network_mode: ${template.network}`);
	}

	if (template.ports && template.ports.length > 0 && !template.network) {
		lines.push('    ports:');
		for (const port of template.ports) {
			lines.push(`      - "${port}"`);
		}
	}

	if (template.volumes && template.volumes.length > 0) {
		lines.push('    volumes:');
		for (const vol of template.volumes) {
			lines.push(`      - ${vol.bind}:${vol.container}`);
		}
	}

	if (template.env && template.env.length > 0) {
		lines.push('    environment:');
		for (const env of template.env) {
			const value = env.default || '';
			lines.push(`      - ${env.name}=${value}`);
		}
	}

	return lines.join('\n') + '\n';
}

async function fetchStackCompose(repository: { url: string; stackfile: string }): Promise<string> {
	// Convert GitHub URL to raw content URL
	let rawUrl = '';
	const githubMatch = repository.url.match(/github\.com\/([^/]+\/[^/]+)/);

	if (githubMatch) {
		const repo = githubMatch[1].replace(/\.git$/, '');
		// Try main branch first, then master
		for (const branch of ['main', 'master']) {
			const url = `https://raw.githubusercontent.com/${repo}/${branch}/${repository.stackfile}`;
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
				if (response.ok) {
					return await response.text();
				}
			} catch {
				continue;
			}
		}
	}

	// Try the URL directly as fallback
	if (!rawUrl) {
		rawUrl = repository.url.endsWith('/')
			? `${repository.url}${repository.stackfile}`
			: `${repository.url}/${repository.stackfile}`;
	}

	const response = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
	if (!response.ok) {
		throw new Error(`Failed to fetch compose file: ${response.status}`);
	}
	return await response.text();
}

/**
 * POST /api/templates/compose - Generate/fetch a compose file for a template
 *
 * @openapi
 * summary: Return the compose YAML for a template — generated for container templates, fetched from the repository for stack templates
 * body: {template:{id:string, type:string, title:string, image:string, repository:{url:string, stackfile:string}}!}
 * body-example: {"template":{"id":"a1b2c3","type":"container","title":"Nginx","image":"nginx:latest"}}
 * resp-200: {compose:string!}
 * resp-200-example: {"compose":"services:\n  nginx:\n    image: nginx:latest\n    restart: unless-stopped\n"}
 * resp-400: Template is missing from the request body
 * resp-403: Permission denied
 * resp-500: Failed to generate or fetch the compose file
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('templates', 'deploy')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { template } = await request.json() as { template: TemplateItem };

		if (!template) {
			return json({ error: 'Template is required' }, { status: 400 });
		}

		let compose: string;

		if (template.type === 'stack' && template.repository) {
			compose = await fetchStackCompose(template.repository);
		} else {
			compose = generateContainerCompose(template);
		}

		return json({ compose });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to generate compose';
		return json({ error: message }, { status: 500 });
	}
};
