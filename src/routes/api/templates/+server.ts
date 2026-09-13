import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { isSafeWebhookUrl } from '$lib/server/url-safety';
import { getTemplateSources, type TemplateSource } from '$lib/server/templates';
import { getAs93Slugs, resolveAs93Url } from '$lib/server/as93-slugs';

export interface TemplateItem {
	id: string;
	type: 'container' | 'stack';
	title: string;
	description: string;
	logo: string;
	categories: string[];
	source: string;
	image?: string;
	ports?: string[];
	volumes?: { bind: string; container: string }[];
	env?: { name: string; label: string; default?: string }[];
	restartPolicy?: string;
	repository?: { url: string; stackfile: string };
	stars?: number;
	pulls?: number;
	network?: string;
	/** Free-form maintainer / install notes from the upstream catalog. */
	note?: string;
	/** Project / homepage URL the user can click to learn more or report issues (#1211). */
	projectUrl?: string;
	/** Rich per-template page on portainer-templates.as93.net (Lissy93 catalog only,
	 *  and only when the slug is confirmed to exist - never a dead link) (#1211). */
	detailsUrl?: string;
}

/**
 * Best-effort first-URL extraction from a template's description or note.
 * Order matters: markdown link first, then HTML href, then a bare URL.
 */
function extractFirstUrl(text: string | undefined | null): string | null {
	if (!text) return null;
	const md = text.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
	if (md) return md[1];
	const html = text.match(/<a\s+[^>]*href=["']([^"']+)["']/i);
	if (html) return html[1];
	const plain = text.match(/(https?:\/\/[^\s<>"')]+)/);
	if (plain) return plain[1];
	return null;
}

/**
 * Resolve the "Project" URL surfaced on the card.
 * Priority:
 *   1. URL embedded in `description` — LSIO-style templates have a markdown
 *      link to the actual project repo here, which is what users want most.
 *   2. URL embedded in `note` — Portainer v3 catalogs often put a homepage
 *      link in the install notes.
 *   3. `maintainer` field — Lissy93's templates carry a per-template
 *      maintainer URL; not always the project itself but usually close.
 *   4. `repository.url` — only for stack-type templates, points to the repo
 *      hosting the compose file (closest thing we have).
 */
function resolveProjectUrl(entry: any, description: string, note: string): string | undefined {
	return (
		extractFirstUrl(description) ||
		extractFirstUrl(note) ||
		(typeof entry.maintainer === 'string' ? entry.maintainer.trim() : null) ||
		(entry.repository && typeof entry.repository.url === 'string' ? entry.repository.url : null) ||
		undefined
	);
}

// Server-side cache: url → { data, fetchedAt }
const cache = new Map<string, { data: TemplateItem[]; fetchedAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function hashId(source: string, title: string): string {
	let hash = 0;
	const str = `${source}:${title}`;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

function normalizePortainerTemplate(
	entry: any,
	sourceName: string,
	as93Slugs?: Set<string>
): TemplateItem | null {
	if (!entry.title && !entry.name) return null;
	// Skip Swarm templates (type 2)
	if (entry.type === 2) return null;

	const title = entry.title || entry.name || '';
	const description = entry.description || '';
	const note = typeof entry.note === 'string' ? entry.note : '';
	const template: TemplateItem = {
		id: hashId(sourceName, title),
		type: entry.type === 3 ? 'stack' : 'container',
		title,
		description,
		logo: entry.logo || '',
		categories: Array.isArray(entry.categories) ? entry.categories : [],
		source: sourceName,
		note: note || undefined,
		projectUrl: resolveProjectUrl(entry, description, note),
		// Lissy93 catalog only: a confirmed as93.net details page (else omitted).
		detailsUrl: (as93Slugs && resolveAs93Url(title, as93Slugs)) || undefined
	};

	if (entry.type === 3 && entry.repository) {
		template.repository = {
			url: entry.repository.url,
			stackfile: entry.repository.stackfile
		};
	} else {
		template.image = entry.image || '';
		template.ports = Array.isArray(entry.ports) ? entry.ports : [];
		template.volumes = Array.isArray(entry.volumes) ? entry.volumes : [];
		template.env = Array.isArray(entry.env) ? entry.env.map((e: any) => ({
			name: e.name || '',
			label: e.label || e.name || '',
			default: e.default ?? e.set ?? ''
		})) : [];
		template.restartPolicy = entry.restart_policy || 'unless-stopped';
		if (entry.network) template.network = entry.network;
	}

	return template;
}

function normalizeLinuxServerTemplate(entry: any): TemplateItem | null {
	if (!entry.name || entry.deprecated) return null;

	const description = entry.description || '';
	// LSIO fleet entries sometimes carry a project_url; prefer it over regex sniffing.
	const projectUrl =
		(typeof entry.project_url === 'string' && entry.project_url) ||
		extractFirstUrl(description) ||
		`https://github.com/linuxserver/docker-${entry.name}`;

	return {
		id: hashId('LinuxServer.io', entry.name),
		type: 'container',
		title: entry.name,
		description,
		logo: entry.project_logo || '',
		categories: entry.category ? entry.category.split(',').map((c: string) => c.trim()).filter(Boolean) : [],
		source: 'LinuxServer.io',
		image: `lscr.io/linuxserver/${entry.name}:latest`,
		env: [
			{ name: 'PUID', label: 'User ID', default: '1000' },
			{ name: 'PGID', label: 'Group ID', default: '1000' },
			{ name: 'TZ', label: 'Timezone', default: 'Etc/UTC' },
		],
		restartPolicy: 'unless-stopped',
		stars: entry.stars,
		pulls: entry.monthly_pulls,
		projectUrl
	};
}

async function fetchSource(source: TemplateSource): Promise<TemplateItem[]> {
	const cached = cache.get(source.url);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
		return cached.data;
	}

	// The source URL is user-configured, so guard against SSRF: a template source
	// always lives on a public host, so block loopback/private/link-local/metadata
	// (strict policy) and refuse redirects that could bounce to a private host.
	const safety = isSafeWebhookUrl(source.url);
	if (!safety.ok) {
		console.error(`[Templates] Refusing to fetch ${source.name}: ${safety.reason}`);
		return cached?.data || [];
	}

	try {
		const response = await fetch(source.url, {
			headers: { 'Accept': 'application/json' },
			redirect: 'manual',
			signal: AbortSignal.timeout(15000),
		});

		if (response.status >= 300 && response.status < 400) {
			console.error(`[Templates] Refusing to fetch ${source.name}: source redirected the request`);
			return cached?.data || [];
		}

		if (!response.ok) {
			console.error(`[Templates] Failed to fetch ${source.name}: ${response.status}`);
			return cached?.data || [];
		}

		const raw = await response.json();
		let templates: TemplateItem[];

		if (source.id === 'linuxserver' || source.url.includes('fleet.linuxserver.io')) {
			// LinuxServer.io fleet API returns an array of images
			const images = Array.isArray(raw) ? raw : (raw.images || []);
			templates = images.map(normalizeLinuxServerTemplate).filter(Boolean) as TemplateItem[];
		} else {
			// Portainer-format templates
			const entries = Array.isArray(raw) ? raw : (raw.templates || []);
			// Lissy93 catalog: load the as93.net slug set once so each template can get a
			// confirmed "Details" link (#1211). Fail-safe: any error yields an empty set,
			// so templates still load - they just get no Details link.
			const isLissy93 = /Lissy93\/portainer-templates/i.test(source.url);
			// getAs93Slugs never throws (returns an empty set on any failure), so a
			// sitemap outage just means no Details links - templates still load.
			const as93Slugs = isLissy93 ? await getAs93Slugs() : undefined;
			templates = entries
				.map((e: any) => normalizePortainerTemplate(e, source.name, as93Slugs))
				.filter(Boolean) as TemplateItem[];
		}

		cache.set(source.url, { data: templates, fetchedAt: Date.now() });
		return templates;
	} catch (error) {
		console.error(`[Templates] Error fetching ${source.name}:`, error instanceof Error ? error.message : error);
		return cached?.data || [];
	}
}

/**
 * GET /api/templates - Aggregated app templates from enabled sources
 *
 * @openapi
 * summary: Return the normalized app templates aggregated from all enabled template sources (server-side cached for 1 hour)
 * resp-200: array<{id:string!, type:string!, title:string!, description:string!, logo:string!, categories:array<string>!, source:string!, image:string, projectUrl:string, detailsUrl:string}>
 * resp-200-example: [{"id":"a1b2c3","type":"container","title":"Nginx","description":"Web server","logo":"https://example.com/nginx.png","categories":["web"],"source":"LinuxServer.io","image":"lscr.io/linuxserver/nginx:latest","projectUrl":"https://github.com/linuxserver/docker-nginx"}]
 * resp-403: Permission denied
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('templates', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const sources = await getTemplateSources();
	const enabledSources = sources.filter(s => s.enabled);

	const results = await Promise.all(enabledSources.map(fetchSource));
	const templates = results.flat();

	return json(templates);
};
