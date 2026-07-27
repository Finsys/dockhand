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
