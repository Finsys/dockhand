/**
 * The stacks page offers health inside the status dropdown as synthetic 'health:*'
 * values, so one predicate has to read both kinds.
 */
import { describe, it, expect } from 'bun:test';
import {
	matchesStackFilter,
	matchesContainerHealthFilter,
	stateFilterValues
} from '../src/lib/utils/grid-filters';

describe('matchesStackFilter', () => {
	const running = { status: 'running', health: 'healthy' };
	const sick = { status: 'running', health: 'unhealthy' };
	const plain = { status: 'running' };

	it('keeps everything when nothing is selected', () => {
		expect(matchesStackFilter(sick, [])).toBe(true);
	});

	it('matches a selected state', () => {
		expect(matchesStackFilter(running, ['running'])).toBe(true);
		expect(matchesStackFilter(running, ['stopped'])).toBe(false);
	});

	it('matches a selected health', () => {
		expect(matchesStackFilter(sick, ['health:unhealthy'])).toBe(true);
		expect(matchesStackFilter(running, ['health:unhealthy'])).toBe(false);
	});

	// A stack with no healthcheck must not answer a health filter at all.
	it('never matches a health filter when health is undefined', () => {
		expect(matchesStackFilter(plain, ['health:unhealthy'])).toBe(false);
		expect(matchesStackFilter(plain, ['health:starting'])).toBe(false);
		expect(matchesStackFilter(plain, ['health:healthy'])).toBe(false);
	});

	// Each kind narrows the other: Running + Unhealthy asks for running stacks that
	// are sick, not for every stack that is either.
	it('intersects the state with the health', () => {
		expect(matchesStackFilter(sick, ['running', 'health:unhealthy'])).toBe(true);
		expect(matchesStackFilter(sick, ['stopped', 'health:unhealthy'])).toBe(false);
		expect(matchesStackFilter(running, ['running', 'health:unhealthy'])).toBe(false);
	});

	// Order must not decide the answer - a predicate that returns on its first match
	// would pass the case above and still be wrong.
	it('gives the same answer whichever order the values arrive in', () => {
		expect(matchesStackFilter(sick, ['health:unhealthy', 'stopped'])).toBe(false);
		expect(matchesStackFilter(running, ['health:unhealthy', 'running'])).toBe(false);
		expect(matchesStackFilter(sick, ['health:unhealthy', 'running'])).toBe(true);
	});

	it('still unions within one kind', () => {
		expect(matchesStackFilter(running, ['running', 'stopped'])).toBe(true);
		expect(matchesStackFilter(sick, ['health:unhealthy', 'health:starting'])).toBe(true);
	});

	// The grid filters on the displayed status, which differs for an undeployed git stack.
	it('matches against the display status when given one', () => {
		const git = { status: 'created' };
		expect(matchesStackFilter(git, ['not deployed'], 'not deployed')).toBe(true);
		expect(matchesStackFilter(git, ['created'], 'not deployed')).toBe(false);
	});

	// Statuses reaching the grid are not all lowercase at the source, and the filter
	// values always are.
	it('compares the state case-insensitively', () => {
		expect(matchesStackFilter({ status: 'Running' }, ['running'])).toBe(true);
		expect(matchesStackFilter({ status: 'created' }, ['created'], 'Not deployed')).toBe(false);
		expect(matchesStackFilter({ status: 'created' }, ['not deployed'], 'Not deployed')).toBe(true);
	});

	it('does not confuse a health value with a state of the same name', () => {
		expect(matchesStackFilter({ status: 'healthy' }, ['health:healthy'])).toBe(false);
	});
});

describe('matchesContainerHealthFilter', () => {
	it('keeps everything when no health is selected', () => {
		expect(matchesContainerHealthFilter(undefined, [])).toBe(true);
		expect(matchesContainerHealthFilter('unhealthy', ['running'])).toBe(true);
	});

	it('keeps only the selected health', () => {
		expect(matchesContainerHealthFilter('unhealthy', ['health:unhealthy'])).toBe(true);
		expect(matchesContainerHealthFilter('healthy', ['health:unhealthy'])).toBe(false);
	});

	// A container with no healthcheck must not answer a health filter.
	it('drops a container with no health when one is selected', () => {
		expect(matchesContainerHealthFilter(undefined, ['health:unhealthy'])).toBe(false);
		expect(matchesContainerHealthFilter(undefined, ['health:healthy'])).toBe(false);
	});

	it('unions several selected healths', () => {
		expect(matchesContainerHealthFilter('starting', ['health:unhealthy', 'health:starting'])).toBe(true);
		expect(matchesContainerHealthFilter('healthy', ['health:unhealthy', 'health:starting'])).toBe(false);
	});
});

describe('stateFilterValues', () => {
	const SYNTH = ['update-available', 'newer-version'];

	it('keeps real states only', () => {
		expect(stateFilterValues(['running', 'exited'], SYNTH)).toEqual(['running', 'exited']);
	});

	// Health and the pre-existing synthetic values must never be read as Docker states,
	// or selecting one would match no state and empty the list.
	it('removes health and the caller-named synthetic values', () => {
		expect(stateFilterValues(['health:unhealthy'], SYNTH)).toEqual([]);
		expect(stateFilterValues(['update-available', 'newer-version'], SYNTH)).toEqual([]);
		expect(stateFilterValues(['running', 'health:unhealthy', 'update-available'], SYNTH)).toEqual(['running']);
	});

	it('returns an empty list for an empty selection', () => {
		expect(stateFilterValues([], SYNTH)).toEqual([]);
	});
});
