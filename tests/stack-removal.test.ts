import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
	DEFAULT_STACK_REMOVAL_OPTIONS,
	buildStackRemovalSearchParams,
	parseStackRemovalSearchParams
} from '../src/lib/utils/stack-removal';
import {
	getRemoteStackRemovalFiles,
	removeStackDirectory
} from '../src/lib/server/stack-removal';

const testDirs: string[] = [];

function createStackFiles(): { root: string; stackDir: string; unrelatedFile: string } {
	const root = mkdtempSync(join(tmpdir(), 'dockhand-stack-removal-'));
	testDirs.push(root);
	const stackDir = join(root, 'example');
	const unrelatedDir = join(root, 'unrelated');
	mkdirSync(stackDir);
	mkdirSync(unrelatedDir);
	writeFileSync(join(stackDir, 'compose.yaml'), 'services: {}\n');
	writeFileSync(join(stackDir, '.env'), 'TOKEN=secret\n');
	writeFileSync(join(stackDir, 'compose.override.yaml'), 'services: {}\n');
	const unrelatedFile = join(unrelatedDir, 'keep.txt');
	writeFileSync(unrelatedFile, 'untouched\n');
	return { root, stackDir, unrelatedFile };
}

afterEach(() => {
	for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stack removal files', () => {
	it('preserves Compose, environment, related, and unrelated files when disabled', () => {
		const { stackDir, unrelatedFile } = createStackFiles();

		assert.equal(removeStackDirectory(stackDir, false), null);
		assert.equal(existsSync(join(stackDir, 'compose.yaml')), true);
		assert.equal(existsSync(join(stackDir, '.env')), true);
		assert.equal(existsSync(join(stackDir, 'compose.override.yaml')), true);
		assert.equal(existsSync(unrelatedFile), true);
	});

	it('retains the existing directory deletion behavior when enabled', () => {
		const { stackDir, unrelatedFile } = createStackFiles();

		assert.equal(removeStackDirectory(stackDir, true), null);
		assert.equal(existsSync(stackDir), false);
		assert.equal(existsSync(unrelatedFile), true);
	});

	it('propagates the same file choice to remote stack cleanup', () => {
		const files = [{ path: 'compose.yaml', hash: 'sha256' }];
		assert.deepEqual(getRemoteStackRemovalFiles(false, files), {
			removeFiles: false,
			filesToDelete: undefined
		});
		assert.deepEqual(getRemoteStackRemovalFiles(true, files), {
			removeFiles: true,
			filesToDelete: files
		});
	});
});

describe('stack removal request options', () => {
	it('defaults the Dockhand UI to preserving files and volumes', () => {
		assert.deepEqual(DEFAULT_STACK_REMOVAL_OPTIONS, {
			deleteFiles: false,
			deleteVolumes: false
		});
		assert.equal(buildStackRemovalSearchParams(DEFAULT_STACK_REMOVAL_OPTIONS).toString(), 'force=true&files=false');
	});

	it('sends explicit file deletion without changing volume behavior', () => {
		const params = buildStackRemovalSearchParams({ deleteFiles: true, deleteVolumes: false });
		assert.equal(params.get('files'), 'true');
		assert.equal(params.has('volumes'), false);
	});

	it('keeps volume removal independent from file deletion', () => {
		const params = buildStackRemovalSearchParams({ deleteFiles: false, deleteVolumes: true });
		assert.equal(params.get('files'), 'false');
		assert.equal(params.get('volumes'), 'true');
	});

	it('keeps the backend default compatible for callers that omit files', () => {
		assert.deepEqual(parseStackRemovalSearchParams(new URLSearchParams('force=true&volumes=true')), {
			force: true,
			removeVolumes: true,
			deleteFiles: true
		});
		assert.deepEqual(parseStackRemovalSearchParams(new URLSearchParams('files=false')), {
			force: false,
			removeVolumes: false,
			deleteFiles: false
		});
	});
});
