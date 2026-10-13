import { describe, test, expect } from 'bun:test';
import { showsManagementActions } from '../src/lib/utils/stack-actions';

describe('showsManagementActions', () => {
	test('non-git stopped/created stacks show actions (the Start button regression)', () => {
		expect(showsManagementActions('internal', 'created')).toBe(true);
		expect(showsManagementActions('internal', 'stopped')).toBe(true);
		expect(showsManagementActions('external', 'created')).toBe(true);
		expect(showsManagementActions(undefined, 'created')).toBe(true);
	});

	test('git stack that has not been deployed (raw "created") hides actions - only the deploy button shows', () => {
		expect(showsManagementActions('git', 'created')).toBe(false);
	});

	test('a deployed git stack shows its management actions', () => {
		expect(showsManagementActions('git', 'running')).toBe(true);
		expect(showsManagementActions('git', 'stopped')).toBe(true);
		expect(showsManagementActions('git', 'partial')).toBe(true);
	});

	test('running/stopped stacks of any source show actions', () => {
		for (const src of ['internal', 'external', 'git', undefined]) {
			expect(showsManagementActions(src, 'running')).toBe(true);
		}
	});
});
