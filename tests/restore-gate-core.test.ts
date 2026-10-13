/**
 * The overwrite gate must be satisfiable for every target it counts. A stack whose compose
 * declares no volumes still replaces its stack dir, so the acknowledgement cannot depend on
 * a volume row being selected.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { countTargetsWithData, overwriteAckReachable } from '../src/lib/utils/restore-gate-core';

describe('countTargetsWithData', () => {
	test('counts only targets that hold data', () => {
		expect(countTargetsWithData([{ hasData: 'has-data' }, { hasData: 'empty' }], null)).toBe(1);
		// The near misses for has-data: each is a different answer and none of them is data.
		expect(countTargetsWithData([{ hasData: 'empty' }, { hasData: 'missing' }], null)).toBe(0);
		expect(countTargetsWithData([{ hasData: 'helper-failed' }, { hasData: 'unreadable' }], null)).toBe(0);
	});

	test('the stack dir counts as a target of its own', () => {
		expect(countTargetsWithData([], { hasData: 'has-data' })).toBe(1);
		expect(countTargetsWithData([{ hasData: 'has-data' }], { hasData: 'has-data' })).toBe(2);
		expect(countTargetsWithData([], { hasData: 'empty' })).toBe(0);
		expect(countTargetsWithData([], null)).toBe(0);
	});

	test('a target with no probe result yet is not counted', () => {
		expect(countTargetsWithData([{}], {})).toBe(0);
	});
});

describe('the gate is always satisfiable', () => {
	// The regression this pins: the stack dir alone held data, the acknowledgement was rendered
	// only alongside selected volume rows, and the restore could never be confirmed.
	test('a stack dir holding data can be acknowledged with no volumes at all', () => {
		const n = countTargetsWithData([], { hasData: 'has-data' });
		expect(n).toBe(1);
		expect(overwriteAckReachable(n)).toBe(true);
	});

	test('nothing holding data needs no acknowledgement', () => {
		const n = countTargetsWithData([{ hasData: 'empty' }], { hasData: 'empty' });
		expect(n).toBe(0);
		expect(overwriteAckReachable(n)).toBe(false);
	});

});


describe('the gate wiring in RestoreModal', () => {
	const source = readFileSync(
		new URL('../src/routes/containers/RestoreModal.svelte', import.meta.url),
		'utf-8'
	);

	// A .svelte template cannot be imported here, so these match SOURCE TEXT: they pin spelling,
	// not behaviour. What they protect is real though - rendering the acknowledgement only
	// alongside selected volume rows makes a volume-less stack impossible to confirm, and the
	// restore button stays disabled with nothing on screen to tick.
	test('the acknowledgement is gated on the shared predicate, not on the volume rows', () => {
		expect(source).toContain('{#if overwriteAckReachable(targetsWithData)}');
		expect(source).not.toMatch(/\{#if selectedRows\.length > 0 && targetsWithData > 0\}/);
	});

	test('the count comes from the shared helper rather than an inline filter', () => {
		expect(source).toContain('countTargetsWithData(targetPreview?.volumes ?? [], targetPreview?.stackFiles)');
	});

	// The stack dir is a target of its own, so it needs a row the user can read the path from.
	test('the stack-files target is rendered', () => {
		expect(source).toContain('targetPreview?.stackFiles?.willWrite');
	});

	// A tick is given for the targets on screen; a changed selection must invalidate it.
	test('the acknowledgement resets when the preview is recomputed', () => {
		const effect = source.slice(source.indexOf('targetPreviewSeq++'));
		expect(effect.slice(0, 600)).toContain('overwriteAck = false');
	});
});
