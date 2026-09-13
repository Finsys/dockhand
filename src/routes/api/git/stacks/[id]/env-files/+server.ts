import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { listGitStackEnvFiles, readGitStackEnvFile } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';

/**
 * GET /api/git/stacks/[id]/env-files
 * List all .env files in the git stack's repository.
 * Returns: { files: string[] }
 */
/**
 * @openapi
 * summary: List the .env files present in a git stack's cloned repository
 * description: Lists the `.env*` files in the git stack's synced repository checkout (read-only). Use this to discover which file to configure as the stack's `envFilePath`. This endpoint does not write — to choose the env file, PUT /api/git/stacks/{id} with `envFilePath`; to set env values, use the stack env endpoints.
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * resp-200: {files:array<string>!}
 * resp-200-example: {"files":[".env",".env.prod"]}
 * resp-400: The repository could not be read (e.g. not yet cloned)
 * resp-403: Caller lacks the stacks:view permission for the stack's environment
 * resp-404: No git stack exists with that ID
 * resp-500: Failed to list the env files
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'view', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const result = await listGitStackEnvFiles(id);
		if (result.error) {
			return json({ files: [], error: result.error }, { status: 400 });
		}

		return json({ files: result.files });
	} catch (error) {
		console.error('Failed to list env files:', error);
		return json({ error: 'Failed to list env files' }, { status: 500 });
	}
};

/**
 * POST /api/git/stacks/[id]/env-files
 * Read and parse a specific .env file from the git stack's repository.
 * Body: { path: string }
 * Returns: { vars: Record<string, string> }
 */
/**
 * @openapi
 * summary: Read and parse one .env file from a git stack's repository into a key/value map
 * description: Reads and parses a single `.env` file (by `path`) from the git stack's synced repository checkout into a key/value map (read-only). There is no write counterpart — git-stack env is set via `envFilePath` (PUT /api/git/stacks/{id}) or the stack env endpoints.
 * path: id:integer! Git stack ID (from GET /api/git/stacks)
 * body: {path:string!}
 * body-example: {"path":".env.prod"}
 * resp-200: {vars:object!}
 * resp-200-example: {"vars":{"TZ":"Europe/Berlin"}}
 * resp-400: The path field is missing or the env file could not be read
 * resp-403: Caller lacks the stacks:view permission for the stack's environment
 * resp-404: No git stack exists with that ID
 * resp-500: Failed to read the env file
 */
export const POST: RequestHandler = async ({ params, cookies, request }) => {
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'view', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const body = await request.json();
		if (!body.path || typeof body.path !== 'string') {
			return json({ error: 'File path is required' }, { status: 400 });
		}

		const result = await readGitStackEnvFile(id, body.path);
		if (result.error) {
			return json({ vars: {}, error: result.error }, { status: 400 });
		}

		return json({ vars: result.vars });
	} catch (error) {
		console.error('Failed to read env file:', error);
		return json({ error: 'Failed to read env file' }, { status: 500 });
	}
};
