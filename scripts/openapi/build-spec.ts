/**
 * Assembles the final OpenAPI 3.0.3 document from discovered routes +
 * (optional, additive) annotations. Shared by `generate` and `--check`
 * (check needs the assembled spec to hand to the validators).
 */

import {
	type DiscoveredRoute,
	type HandlerAnnotation,
	type HttpMethod,
	miniSchemaToOpenApi,
	synthesizeExample
} from './lib';

export interface BuildSpecInput {
	routes: DiscoveredRoute[];
	annotationsByPath: Record<string, Partial<Record<HttpMethod, HandlerAnnotation>>>;
	publicPaths: string[];
	isPublicFn: (path: string) => boolean;
	version: string;
}

export function buildSpec({ routes, annotationsByPath, isPublicFn, version }: BuildSpecInput) {
	const paths: Record<string, Record<string, unknown>> = {};

	for (const route of routes) {
		const pathItem = (paths[route.openapiPath] ??= {});
		const security = isPublicFn(route.openapiPath) ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }];

		for (const method of route.methods) {
			const operationId = `${method.toLowerCase()}_${route.openapiPath.replace(/^\//, '').replace(/[{}]/g, '').replace(/\//g, '_')}`;
			const annotation = annotationsByPath[route.openapiPath]?.[method];

			const responses: Record<string, Record<string, unknown>> = {};
			if (annotation) {
				for (const [code, resp] of Object.entries(annotation.responses)) {
					const entry: Record<string, unknown> = { description: resp.description };
					if (resp.schema) {
						const example = resp.example ?? synthesizeExample(resp.schema);
						entry.content = { 'application/json': { schema: miniSchemaToOpenApi(resp.schema), example } };
					}
					responses[code] = entry;
				}
			}
			const hasSuccessResponse = Object.keys(responses).some((code) => code.startsWith('2'));
			if (!hasSuccessResponse) {
				responses['200'] = {
					description: annotation ? 'Successful response' : 'Successful response (auto-generated stub — no @openapi annotation yet)'
				};
			}

			const pathParamAnnotations = annotation?.path ?? {};
			const parameters: Record<string, unknown>[] = route.pathParams.map((p) => {
				const enrich = pathParamAnnotations[p];
				return {
					name: p,
					in: 'path',
					required: true,
					schema: { type: enrich?.type ?? 'string' },
					...(enrich?.description ? { description: enrich.description } : {})
				};
			});
			if (annotation) {
				for (const [name, q] of Object.entries(annotation.query)) {
					parameters.push({ name, in: 'query', required: q.required, schema: { type: q.type }, description: q.description });
				}
			}

			const operation: Record<string, unknown> = {
				operationId,
				tags: [route.tag],
				summary: annotation?.summary ?? `${method} ${route.openapiPath} (auto-generated stub — no @openapi annotation yet)`,
				parameters,
				responses,
				security
			};

			if (annotation?.body) {
				const example = annotation.bodyExample ?? synthesizeExample(annotation.body);
				operation.requestBody = {
					required: true,
					content: { 'application/json': { schema: miniSchemaToOpenApi(annotation.body), example } }
				};
			}

			pathItem[method.toLowerCase()] = operation;
		}
	}

	return {
		openapi: '3.0.3',
		info: {
			title: 'Dockhand API',
			version,
			description:
				'Auto-generated from src/routes/**/+server.ts by scripts/generate-openapi.ts. ' +
				'Path, HTTP method, tag, and auth requirement are derived automatically from the ' +
				'route tree and hooks.server.ts PUBLIC_PATHS — adding a new endpoint requires ZERO ' +
				'manual spec edits for those fields. Request/response schemas and examples come from ' +
				'an optional, additive `@openapi` JSDoc annotation on the handler; endpoints without ' +
				'one remain fully functional generic stubs (path/method/tag/auth are unaffected).'
		},
		servers: [{ url: '/' }],
		tags: Array.from(new Set(routes.map((r) => r.tag)))
			.sort()
			.map((t) => ({ name: t })),
		components: {
			securitySchemes: {
				cookieAuth: {
					type: 'apiKey',
					in: 'cookie',
					name: 'dockhand_session',
					description: 'Session cookie set on login (src/lib/server/auth.ts validateSession).'
				},
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'dh_<43-char base64url>',
					description:
						'User-scoped API token (src/lib/server/api-tokens.ts). Only evaluated on /api/* and ' +
						'/metrics when no session cookie is present (src/hooks.server.ts). Rate-limited: ' +
						'10 failures/IP -> 429 for 5 minutes.'
				}
			}
		},
		security: [{ cookieAuth: [] }, { bearerAuth: [] }],
		paths
	};
}
