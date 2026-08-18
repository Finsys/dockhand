/**
 * Feature flags (opt-in, env-var gated).
 *
 * BETA GATE — REMOVE WHEN BACKUPS GOES GA.
 * The containers & stacks backup feature ships dark by default. Enable per
 * instance with FEAT_BACKUPS_ENABLED=true. Read once at boot.
 *
 * To remove the gate when backups is GA:
 *   1. Delete this file.
 *   2. Delete the backups gate block in src/hooks.server.ts.
 *   3. Drop `backupsEnabled` from src/routes/+layout.server.ts.
 *   4. Drop the `feature` field / filter on the backups item in app-sidebar.svelte.
 *   5. Drop the BACKUPS_ENABLED guards in src/lib/server/scheduler/index.ts.
 */
export const BACKUPS_ENABLED = process.env.FEAT_BACKUPS_ENABLED === 'true';

/**
* API docs (OpenAPI spec + Scalar viewer at /api/docs and /api/docs/ui).
 * Off by default: the docs routes are unauthenticated, so exposing the full
 * API surface is opt-in per instance with FEAT_API_DOCS=true. Read once at boot.
 */
export const API_DOCS_ENABLED = process.env.FEAT_API_DOCS === 'true';

/**
 * Git repository model: setting `DOCKHAND_GIT_CENTRALIZED_MODE=true` forces the
 * **desired** mode to `centralized` (env wins over the UI setting; only the exact
 * value `true` forces centralized). Any OTHER non-empty value forces the desired
 * mode to `stack` (e.g. `=false` or `=0` explicitly request stack mode), and
 * locks the mode from the UI either way — remove the variable to hand control
 * back to Settings. Read once at boot — see git-mode.ts for how the desired mode
 * drives the (transition-job-controlled) effective mode.
 */
export const GIT_CENTRALIZED_MODE_ENV_FORCED =
	process.env.DOCKHAND_GIT_CENTRALIZED_MODE !== undefined &&
	process.env.DOCKHAND_GIT_CENTRALIZED_MODE !== '';
