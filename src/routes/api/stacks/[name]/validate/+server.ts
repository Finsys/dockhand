import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { runValidateWithConfig } from '$lib/server/compose-validate';
import { buildValidateContext } from '$lib/server/compose-validate/context';
import { pickAdditionalComposeContents } from '$lib/server/compose-files';
import { getEnvironment } from '$lib/server/db';
import type { ValidateConfig } from '$lib/server/compose-validate/types';
import type { RequestHandler } from './$types';

/**
 * The daemon `docker compose config` should validate against. `config` renders the
 * effective compose locally (it does NOT dial the daemon), so this only matters for
 * consistency: local/socket -> default socket; direct TCP -> that host. Hawser/edge
 * agents are remote, so we skip config for them (null) and fall back to local rules.
 */
async function resolveDockerHostForConfig(envIdNum: number | undefined): Promise<string | null> {
	if (!envIdNum) return null; // no env -> local socket
	const env = await getEnvironment(envIdNum).catch(() => undefined);
	if (!env) return null;
	const type = env.connectionType || 'socket';
	if (type === 'socket') return null;
	if (type === 'direct' && env.host) {
		const proto = env.protocol === 'https' ? 'https' : 'tcp';
		return `${proto}://${env.host}:${env.port || 2375}`;
	}
	return null; // hawser-standard / hawser-edge: no local TCP host, config renders locally anyway
}

/**
 * Validate a compose file (Compose Validate): a preflight linter that surfaces
 * problems - port collisions, exposure, typos, undefined network/volume refs, latest
 * tags, docker.sock mounts - before `docker compose up`, with the line of each finding
 * for editor markers. Context-aware rules (cross-stack port collisions, missing
 * external networks/volumes, container-name collisions) use the target environment's
 * live containers/networks/volumes.
 *
 * @openapi
 * summary: Run the Compose Validate preflight linter on a compose file and return findings with severities and line numbers (requires the 'view' permission)
 * path: name:string! Stack name (used to exclude the stack's own containers from cross-stack collision checks)
 * query: env:integer Environment ID for the context-aware checks (from GET /api/environments)
 * body: {compose:string!, config:{disabled:[string], severity:object}, envVars:object}
 * body-example: {"compose":"services:\n  web:\n    image: nginx:latest\n    ports: [\"8080:80\"]\n"}
 * resp-200: {findings:[{ruleId:string!, severity:string!, message:string!, hint:string, service:string, line:integer, fix:object, fixDescription:string}]!, counts:{error:integer!, warn:integer!, info:integer!}!}
 * resp-200-example: {"findings":[{"ruleId":"LATEST_TAG","severity":"warn","message":"\"web\" uses `:latest` (nginx:latest)","hint":"Pin a version tag for reproducible deploys and to enable newer-version detection.","service":"web","line":3}],"counts":{"error":0,"warn":1,"info":0}}
 * resp-400: compose content is required
 * resp-403: Permission denied
 */
export const POST: RequestHandler = async ({ cookies, url, params, request }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId, 10) : undefined;

	if (auth.authEnabled && !(await auth.can('stacks', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envIdNum ?? null);
	if (envAccessDenied) return envAccessDenied;

	const body = (await request.json().catch(() => ({}))) as {
		compose?: string;
		// Ordered multi-file set (primary first). `compose` is the primary
		// content; composePaths[1..] pick additional files out of composeContents
		// so validation merges exactly what deploy will.
		composePaths?: unknown;
		composeContents?: unknown;
		config?: ValidateConfig;
		envVars?: Record<string, string>;
		existing?: boolean;
	};
	const compose = typeof body.compose === 'string' ? body.compose : '';
	if (!compose.trim()) {
		return json({ error: 'compose content is required' }, { status: 400 });
	}

	// Resolve the additional files (in order, primary first) from the submitted set.
	const additionalSources = pickAdditionalComposeContents(body.composePaths, body.composeContents);
	const submittedContents = typeof body.composeContents === 'object' && body.composeContents !== null
		? body.composeContents as Record<string, unknown>
		: {};
	const sourceNames = Array.isArray(body.composePaths)
		? body.composePaths.filter((p, index): p is string =>
			typeof p === 'string' && p.trim().length > 0 &&
			(index === 0 || (typeof submittedContents[p] === 'string' && (submittedContents[p] as string).trim().length > 0))
		)
		: [];

	// The editor's current env vars (incl. secrets) so `docker compose config` resolves
	// `${VAR}` the same way a deploy will, instead of reporting a spurious "VAR not set".
	const envVars: Record<string, string> = {};
	if (body.envVars && typeof body.envVars === 'object') {
		for (const [k, v] of Object.entries(body.envVars)) {
			if (typeof k === 'string' && typeof v === 'string') envVars[k] = v;
		}
	}

	const stackName = decodeURIComponent(params.name);
	// Self-exclusion (don't flag the stack's own running containers/ports as collisions)
	// applies ONLY when editing an existing stack. A brand-new stack has no own containers,
	// so a name/port clash with a running stack of the same name must still be reported.
	const selfStackName = body.existing ? stackName : null;

	// Best-effort live context; degrades to an empty context if the env is unreachable
	// (context-aware rules then simply produce nothing - the linter still runs).
	const ctx = await buildValidateContext(envIdNum ?? null, selfStackName).catch(() => ({}));

	// `docker compose config` gives the authoritative schema/syntax verdict; the local
	// rule catalog adds the context-aware checks config can't do. Config degrades to a
	// pure local lint if the daemon/CLI is unreachable, so this never blocks.
	const dockerHost = await resolveDockerHostForConfig(envIdNum);
	const report = await runValidateWithConfig(stackName, compose, ctx, dockerHost, body.config ?? {}, envVars, additionalSources, sourceNames);
	return json(report);
};
