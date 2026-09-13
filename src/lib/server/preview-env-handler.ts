/**
 * Preview-env handler core — import-light, dependency-injected.
 *
 * The POST /api/git/preview-env route (src/routes/api/git/preview-env/
 * +server.ts) is a thin wrapper that resolves the real dependencies
 * (authorize, getGitRepository, getGitCredential, previewRepoEnvFiles, the
 * SSRF guards) and calls this function. The route performs the HTTP/status
 * mapping (json(..., { status: NNN })), so the OpenAPI generator (which
 * statically scans the +server.ts handler body) sees all status codes.
 *
 * Keeping the business/security logic here — with all external dependencies
 * injected — makes the EXACT production pipeline (permission gate, body
 * parsing, SSRF/credential/path guards, error handling) directly testable
 * without importing the SvelteKit route (which transitively loads the native
 * database layer) or leaving global mock.module() state behind.
 *
 * The authorization regression tests in tests/preview-env-security.test.ts
 * execute this function with injected fakes. The tested function IS the
 * production pipeline invoked by the POST route — if the route's
 * `auth.can('git','edit')` gate is removed, the tests break.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreviewEnvDependencies {
	/** Resolve the auth context for the request cookies (authorization gate). */
	authorize: (cookies: unknown) => Promise<PreviewEnvAuthContext>;
	/** Look up an existing repository by id. */
	getGitRepository: (id: number) => Promise<PreviewEnvRepository | null>;
	/** Look up a stored credential by id. */
	getGitCredential: (id: number) => Promise<PreviewEnvCredential | null>;
	/** Clone the repo and read env files. */
	previewRepoEnvFiles: (opts: PreviewEnvPreviewOptions) => Promise<PreviewEnvPreviewResult>;
	/** SSRF + transport denylist guard. Throws on unsafe target. */
	assertSafeRepoTarget: (url: string) => void;
}

export interface PreviewEnvAuthContext {
	authEnabled: boolean;
	isAuthenticated: boolean;
	user: unknown;
	isAdmin: boolean;
	isEnterprise: boolean;
	can: (resource: string, action: string) => Promise<boolean>;
}

export interface PreviewEnvRepository {
	url: string;
	branch: string;
	credentialId: number | null;
}

export interface PreviewEnvCredential {
	id: number;
	name: string;
	authType: string;
	username: string;
	secret?: string;
}

export interface PreviewEnvPreviewOptions {
	repoUrl: string;
	branch: string;
	credential: PreviewEnvCredential | null;
	composePath: string;
	envFilePath: string | null;
}

export interface PreviewEnvPreviewResult {
	vars: Record<string, string>;
	sources: Record<string, string>;
	error?: string;
}

/**
 * The result of the preview-env pipeline. The route maps this to an HTTP
 * response (status + json body).
 */
export type PreviewEnvOutcome =
	| { kind: 'success'; vars: Record<string, string>; sources: Record<string, string> }
	| { kind: 'permission-denied' }
	| { kind: 'bad-request'; message: string; vars?: Record<string, string>; sources?: Record<string, string> }
	| { kind: 'not-found' }
	| { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Handler core
// ---------------------------------------------------------------------------

/**
 * The preview-env handler pipeline. This is the SAME code path the POST route
 * executes (the route resolves the real dependencies and forwards to this
 * function), so testing this function with injected fakes exercises the real
 * production logic — not a mirror.
 *
 * The `git:edit` permission gate runs BEFORE `request.json()`
 * (attacker-controlled input), repository/credential lookup, URL processing,
 * and any git subprocess.
 */
export async function handlePreviewEnv(
	deps: PreviewEnvDependencies,
	args: { request: { json: () => Promise<any> }; cookies: unknown }
): Promise<PreviewEnvOutcome> {
	const auth = await deps.authorize(args.cookies);

	// Permission gate: the endpoint clones a USER-SUPPLIED URL and
	// reads env files from it, so it is gated on the git:edit permission —
	// the EXACT same model as POST /api/git/branches. This single check covers
	// every authenticated case:
	//   - auth disabled        -> can('git','edit') is true, allowed to continue;
	//   - auth enabled + unauthenticated -> can('git','edit') is false -> 403;
	//   - auth enabled + read-only      -> can('git','edit') is false -> 403;
	//   - auth enabled + git:edit       -> allowed to continue.
	// (There is deliberately no separate 401 branch — an unauthenticated
	// request simply lacks the git:edit permission and is denied, matching
	// /api/git/branches.)
	if (auth.authEnabled && !(await auth.can('git', 'edit'))) {
		return { kind: 'permission-denied' };
	}

	try {
		const data = await args.request.json();

		if (!data.composePath || typeof data.composePath !== 'string') {
			return { kind: 'bad-request', message: 'Compose path is required' };
		}

		let repoUrl: string;
		let branch: string = 'main';
		let credentialId: number | null = null;

		if (data.repositoryId) {
			// Use existing repository
			const repo = await deps.getGitRepository(data.repositoryId);
			if (!repo) {
				return { kind: 'not-found' };
			}
			repoUrl = repo.url;
			// An explicit branch (e.g. a per-stack override being previewed)
			// wins over the repository default.
			branch = typeof data.branch === 'string' && data.branch.trim() ? data.branch.trim() : repo.branch;
			credentialId = repo.credentialId;
		} else if (data.url) {
			// New repository details
			repoUrl = data.url;
			branch = data.branch || 'main';
			credentialId = data.credentialId || null;
		} else {
			return { kind: 'bad-request', message: 'Either repositoryId or url is required' };
		}

		// Get credential if specified
		let credential: PreviewEnvCredential | null = null;
		if (credentialId) {
			credential = await deps.getGitCredential(credentialId);
		}

		// Security: the preview endpoint clones a
		// USER-SUPPLIED URL and reads env files from it. Run the shared guards
		// BEFORE previewRepoEnvFiles spawns git / reads files.
		//  1. assertSafeRepoTarget — SSRF + transport denylist.
		try {
			deps.assertSafeRepoTarget(repoUrl);
		} catch (e: any) {
			return { kind: 'bad-request', message: e.message || 'Invalid repository URL' };
		}

		const result = await deps.previewRepoEnvFiles({
			repoUrl,
			branch,
			credential,
			composePath: data.composePath,
			envFilePath: data.envFilePath || null
		});

		if (result.error) {
			return { kind: 'bad-request', message: result.error, vars: {}, sources: {} };
		}

		return { kind: 'success', vars: result.vars, sources: result.sources };
	} catch (error: any) {
		return { kind: 'error', message: error.message || 'Failed to preview env files' };
	}
}
