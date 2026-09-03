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
 * Whether git webhooks may be enabled WITHOUT a secret (isolated-network escape hatch).
 * Surfaced to the client so the git-stack form can relax its "secret required" validation
 * to match the server, which gates the same rule via allowSecretlessWebhook(). Read once at
 * boot. Default false: a secret is required.
 */
export const ALLOW_WEBHOOKS_WITHOUT_SECRET = process.env.ALLOW_WEBHOOKS_WITHOUT_SECRET === 'true';
