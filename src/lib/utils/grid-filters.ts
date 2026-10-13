/**
 * Decide whether a stack survives the stacks page's status filter, which carries two
 * kinds of value: real states, and health as synthetic 'health:*' entries.
 *
 * Each kind ANDs with the other, matching how the containers page composes its own
 * synthetic values: selecting Running plus Unhealthy asks for running stacks that are
 * sick, not for every stack that is either.
 */
export function matchesStackFilter(
	stack: { status: string; health?: string },
	selected: string[],
	displayStatus = stack.status
): boolean {
	if (selected.length === 0) return true;

	const states = selected.filter((v) => !v.startsWith('health:'));
	const healths = selected.filter((v) => v.startsWith('health:')).map((v) => v.slice(7));

	if (states.length > 0 && !states.includes(displayStatus.toLowerCase())) return false;
	if (healths.length > 0 && !(stack.health !== undefined && healths.includes(stack.health))) {
		return false;
	}
	return true;
}

/**
 * The containers page's equivalent: real Docker states, plus synthetic values that
 * each narrow the result rather than widening it. Kept beside the stacks predicate
 * so the two pages cannot drift into meaning different things by the same selection.
 */
export function matchesContainerHealthFilter(
	health: string | undefined,
	selected: string[]
): boolean {
	const wanted = selected.filter((v) => v.startsWith('health:')).map((v) => v.slice(7));
	if (wanted.length === 0) return true;
	return health !== undefined && wanted.includes(health);
}

/** The selected values that name a real Docker state, with every synthetic one removed. */
export function stateFilterValues(selected: string[], synthetic: string[]): string[] {
	return selected.filter((v) => !v.startsWith('health:') && !synthetic.includes(v));
}
