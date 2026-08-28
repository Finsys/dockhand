import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	findStackNameCollision,
	moveStackFilePathCrossDevice,
	resolveStackDirForLayout
} from '../src/lib/server/stack-path-utils';

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('moveStackFilePathCrossDevice', () => {
	it('copies and deletes the source when rename fails with EXDEV', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-stack-move-'));
		tempDirs.push(dir);
		const source = join(dir, 'old.env');
		const destination = join(dir, 'new.env');
		writeFileSync(source, 'TOKEN=secret\n');

		moveStackFilePathCrossDevice(source, destination, 'env file', () => {
			throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
		});

		expect(readFileSync(destination, 'utf8')).toBe('TOKEN=secret\n');
		expect(existsSync(source)).toBe(false);
	});
});

describe('resolveStackDirForLayout', () => {
	it('uses flat STACKS_DIR for local stacks and environment scope otherwise', () => {
		expect(resolveStackDirForLayout('/data/stacks', '/srv/stacks', 'app', 'local', true)).toBe('/srv/stacks/app');
		expect(resolveStackDirForLayout('/data/stacks', '/srv/stacks', 'app', 'production', false)).toBe('/data/stacks/production/app');
	});
});

describe('findStackNameCollision', () => {
	it('finds the same stack name in another local environment', () => {
		const sources = [
			{ stackName: 'app', environmentId: 1 },
			{ stackName: 'worker', environmentId: 2 }
		];

		expect(findStackNameCollision(sources, 'app', 2)).toEqual(sources[0]);
		expect(findStackNameCollision(sources, 'app', 1)).toBeUndefined();
	});
});
