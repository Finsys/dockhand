/**
 * Assembles the final OpenAPI 3.0.3 document from discovered routes +
 * static analysis of every handler + (optional, additive) annotations.
 * Shared by `generate` and `--check` (check needs the assembled spec to
 * hand to the validators).
 *
 * Layering, cheapest to most precise:
 *   1. Auto-base   — path/method/tag/auth (always, from the route tree +
 *                     hooks.server.ts) PLUS parameters/responses/requestBody
 *                     derived from static analysis of the handler's own code
 *                     (query params via url.searchParams, status codes via
 *                     status:/error(), body fields via destructuring).
 *   2. JSDoc override — an `@openapi` block on the handler replaces/extends
 *                     the auto values with hand-authored summaries, exact
 *                     types, examples, and precise descriptions.
 * An un-annotated handler is therefore NOT a bare stub anymore — it shows
 * every parameter, status code, and body field the static analysis could
 * find in its own source, just with generic descriptions instead of
 * hand-written ones.
 */

import {
	type DiscoveredRoute,
	type HandlerAnnotation,
	type HttpMethod,
	type StaticAnalysis,
	analyzeHandlerBody,
	miniSchemaToOpenApi,
	splitMethodBodies,
	synthesizeExample
} from './lib';

export interface BuildSpecInput {
	routes: DiscoveredRoute[];
	fileContents: Map<string, string>;
	annotationsByPath: Record<string, Partial<Record<HttpMethod, HandlerAnnotation>>>;
	publicPaths: string[];
	isPublicFn: (path: string) => boolean;
	version: string;
}

function genericParamDescription(kind: 'path' | 'query', name: string): string {
	return `${kind === 'path' ? 'Path' : 'Query'} parameter "${name}" (auto-detected from the handler's source — no @openapi annotation for this parameter yet)`;
}

export function buildSpec({ routes, fileContents, annotationsByPath, isPublicFn, version }: BuildSpecInput) {
	const paths: Record<string, Record<string, unknown>> = {};

	// Track auto-enrichment stats for the generator's own report (parameters
	// beyond path, responses beyond a single 200, or a requestBody — any of
	// which the static analysis contributed without a human writing a line).
	let autoParamsCount = 0;
	let autoMultiResponseCount = 0;
	let autoBodyCount = 0;

	for (const route of routes) {
		const pathItem = (paths[route.openapiPath] ??= {});
		const security = isPublicFn(route.openapiPath) ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }];
		const content = fileContents.get(route.filePath);
		const bodies = content ? splitMethodBodies(content) : {};

		for (const method of route.methods) {
			const operationId = `${method.toLowerCase()}_${route.openapiPath.replace(/^\//, '').replace(/[{}]/g, '').replace(/\//g, '_')}`;
			const annotation = annotationsByPath[route.openapiPath]?.[method];
			const methodBody = bodies[method];
			const analysis: StaticAnalysis = methodBody
				? analyzeHandlerBody(methodBody, route.pathParams)
				: { queryParams: [], pathParamTypes: {}, statusCodes: [], bodyFields: [] };

			// --- parameters: auto path + auto query, JSDoc enriches/adds -------
			const pathParamAnnotations = annotation?.path ?? {};
			const parameters: Record<string, unknown>[] = route.pathParams.map((p) => {
				const enrich = pathParamAnnotations[p];
				const autoType = analysis.pathParamTypes[p]; // only set when inferred as non-string
				return {
					name: p,
					in: 'path',
					required: true,
					schema: { type: enrich?.type ?? autoType ?? 'string' },
					description: enrich?.description || genericParamDescription('path', p)
				};
			});

			// Query params: union of auto-detected (from code) and annotated
			// (JSDoc can also document a query param the static analysis missed,
			// e.g. a dynamically-built key). Annotation wins when both exist.
			const annotatedQueryNames = new Set(Object.keys(annotation?.query ?? {}));
			for (const q of analysis.queryParams) {
				if (annotatedQueryNames.has(q.name)) continue; // annotation takes precedence, added below
				parameters.push({
					name: q.name,
					in: 'query',
					required: false, // static analysis can't safely tell required vs optional for query params
					schema: { type: q.type },
					description: genericParamDescription('query', q.name)
				});
			}
			if (annotation) {
				for (const [name, q] of Object.entries(annotation.query)) {
					parameters.push({ name, in: 'query', required: q.required, schema: { type: q.type }, description: q.description });
				}
			}
			if (parameters.length > route.pathParams.length) autoParamsCount++;

			// --- responses: auto status codes, JSDoc enriches/adds ------------
			const responses: Record<string, Record<string, unknown>> = {};
			const annotatedCodes = new Set(Object.keys(annotation?.responses ?? {}));
			for (const code of analysis.statusCodes) {
				if (annotatedCodes.has(code)) continue; // annotation takes precedence, added below
				responses[code] = {
					description: code.startsWith('2')
						? 'Successful response (auto-detected status code — no @openapi annotation for this response yet)'
						: 'Error response (auto-detected status code — no @openapi annotation for this response yet)'
				};
			}
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
				// Neither static analysis nor annotation found an explicit 2xx —
				// every SvelteKit handler that doesn't throw returns *some*
				// success response, so default to 200 rather than omit it.
				responses['200'] = { description: 'Successful response' };
			}
			if (Object.keys(responses).length > 1) autoMultiResponseCount++;

			// --- requestBody: auto body fields (POST/PUT/PATCH only), JSDoc enriches/replaces ---
			let requestBody: Record<string, unknown> | undefined;
			if (annotation?.body) {
				const example = annotation.bodyExample ?? synthesizeExample(annotation.body);
				requestBody = {
					required: true,
					content: { 'application/json': { schema: miniSchemaToOpenApi(annotation.body), example } }
				};
			} else if (annotation?.bodyRaw) {
				// A non-JSON raw body (e.g. application/x-tar): binary string schema.
				const schema: Record<string, unknown> = { type: 'string', format: 'binary' };
				if (annotation.bodyRaw.description) schema.description = annotation.bodyRaw.description;
				requestBody = {
					required: true,
					content: { [annotation.bodyRaw.mediaType]: { schema } }
				};
			} else if (annotation?.bodyMultipart) {
				// A multipart/form-data body with a single (possibly array) file field.
				const mp = annotation.bodyMultipart;
				const fieldSchema: Record<string, unknown> = mp.array
					? { type: 'array', items: { type: mp.type === 'binary' ? 'string' : mp.type, format: mp.type === 'binary' ? 'binary' : undefined } }
					: { type: mp.type === 'binary' ? 'string' : mp.type, format: mp.type === 'binary' ? 'binary' : undefined };
				if (mp.description) fieldSchema.description = mp.description;
				requestBody = {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								properties: { [mp.field]: fieldSchema },
								...(mp.required ? { required: [mp.field] } : {})
							}
						}
					}
				};
			} else if (['POST', 'PUT', 'PATCH'].includes(method) && analysis.bodyFields.length > 0) {
				const properties = Object.fromEntries(analysis.bodyFields.map((f) => [f, { type: 'string' }]));
				requestBody = {
					required: false, // static analysis can't tell which destructured fields are actually required
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties,
								description:
									'Fields auto-detected from the handler’s destructuring of the request body — generic string type, no @openapi annotation for this body yet.'
							}
						}
					}
				};
			}
			if (requestBody) autoBodyCount++;

			const operation: Record<string, unknown> = {
				operationId,
				tags: [route.tag],
				summary: annotation?.summary ?? `${method} ${route.openapiPath} (auto-generated — no @openapi annotation yet)`,
				parameters,
				responses,
				security
			};
			if (annotation?.description) operation.description = annotation.description;
			if (requestBody) operation.requestBody = requestBody;

			pathItem[method.toLowerCase()] = operation;
		}
	}

	const spec = {
		openapi: '3.0.3',
		info: {
			title: 'Dockhand API',
			version,
			description:
				'Auto-generated from src/routes/**/+server.ts by scripts/generate-openapi.ts. ' +
				'Path, HTTP method, tag, and auth requirement are derived automatically from the ' +
				'route tree and hooks.server.ts PUBLIC_PATHS. Parameters, response status codes, and ' +
				'request body fields are additionally auto-detected from each handler’s own source ' +
				'(query params via url.searchParams, status codes via status:/error(), body fields via ' +
				'destructuring) — adding a new endpoint therefore requires ZERO manual spec edits to show ' +
				'up with real params/responses. An optional, additive `@openapi` JSDoc annotation on a ' +
				'handler replaces the generic auto-descriptions with hand-written summaries, exact types, ' +
				'and examples.'
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

	return { spec, stats: { autoParamsCount, autoMultiResponseCount, autoBodyCount } };
}
