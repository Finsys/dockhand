import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	filterStackModel,
	filterCentralizedStacks,
	filterReposWithCentralizedMember,
	resolveGitStackScheduleKind
} from '../src/lib/utils/git-model-routing';

describe('mixed-mode scheduler routing', () => {
	it('filterStackModel selects only stack-model rows', () => {
		const stacks = [
			{ id: 1, repositoryId: 7, engine: 'stack' },
			{ id: 2, repositoryId: 7, engine: 'centralized' },
			{ id: 3, repositoryId: 8, engine: 'stack' }
		];
		const stackModel = filterStackModel(stacks);
		assert.deepEqual(stackModel.map((s) => s.id), [1, 3]);
	});

	it('filterCentralizedStacks selects only centralized-model rows (fan-out)', () => {
		const stacks = [
			{ id: 1, repositoryId: 7, engine: 'stack' },
			{ id: 2, repositoryId: 7, engine: 'centralized' }
		];
		assert.deepEqual(filterCentralizedStacks(stacks).map((s) => s.id), [2]);
	});

	it('filterReposWithCentralizedMember excludes repos with zero centralized stacks', () => {
		const repos = [{ id: 7 }, { id: 8 }, { id: 9 }];
		const stacks = [
			{ id: 1, repositoryId: 7, engine: 'stack' },
			{ id: 2, repositoryId: 7, engine: 'centralized' },
			{ id: 3, repositoryId: 8, engine: 'stack' }
		];
		const eligible = filterReposWithCentralizedMember(repos, stacks);
		assert.deepEqual(eligible.map((r) => r.id), [7]);
	});

	it('filterReposWithCentralizedMember returns nothing when every repo is stack-model only', () => {
		const repos = [{ id: 7 }];
		const stacks = [{ id: 1, repositoryId: 7, engine: 'stack' }];
		assert.deepEqual(filterReposWithCentralizedMember(repos, stacks), []);
	});

	it('resolveGitStackScheduleKind maps a stack-model git_stack_sync to the stack', () => {
		assert.equal(resolveGitStackScheduleKind('stack'), 'stack');
	});

	it('resolveGitStackScheduleKind keeps the repository alias for centralized-model stacks (old fleet cutover leftover)', () => {
		assert.equal(resolveGitStackScheduleKind('centralized'), 'repository');
	});
});
