/**
 * Whether the /metrics endpoint is left reachable without authentication (#1698).
 *
 * Pure so the default-off, fail-closed env parse is a unit test rather than something
 * only a running instance reveals. The rule is strict-equality to the string 'true':
 * an unset, empty, or ANY-other value (1, yes, TRUE) keeps /metrics authenticated, so
 * exposing it is a deliberate, exact opt-in and a typo never opens it.
 */
export function metricsPublicFromEnv(raw: string | undefined): boolean {
	return raw === 'true';
}
