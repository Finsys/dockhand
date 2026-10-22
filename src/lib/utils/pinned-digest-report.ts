/**
 * Whether Dockhand reports a MOVED digest on a `tag@sha256:...` pinned image (#1755).
 *
 * Pure so the server (deciding whether to flag the move) and the tests agree on what
 * an absent value means without a database.
 *
 * Default ON: #1755 shipped this reporting on, so an existing install must keep it, and
 * a fresh one gets it too. Only an explicit `false` turns it off - the opt-out a user
 * who pins deliberately (e.g. the Immich valkey pin) wants, since the move is never
 * applied and is noise to them (#1780).
 */
export function pinnedDigestReportEnabledFromSetting(stored: unknown): boolean {
	return stored !== false;
}
