/**
 * Which binds the backup dialog shows as a single file: the host probe of the stack folder
 * knows file from directory, Docker's inspect does not.
 */
import { describe, test, expect } from 'bun:test';
import { fileBindKeys } from '../src/lib/utils/mounts';

const listing = {
	hostPath: '/data/stacks/pomerium',
	entries: [
		{ name: 'certs', type: 'dir' },
		{ name: 'config.yaml', type: 'file' },
		{ name: 'compose.yaml', type: 'file' }
	]
};
const volumes = [
	{ key: 'certs__certs', mountType: 'bind', source: '/data/stacks/pomerium/certs' },
	{ key: 'pomerium_config.yaml__config.yaml', mountType: 'bind', source: '/data/stacks/pomerium/config.yaml' },
	{ key: 'pomerium_pomerium-cache', mountType: 'volume', source: 'pomerium_pomerium-cache' },
	{ key: 'localtime', mountType: 'bind', source: '/etc/localtime' }
];

describe('fileBindKeys', () => {
	test('a bind of a file in the stack folder is a file; a directory, a volume and a bind elsewhere are not', () => {
		expect([...fileBindKeys(volumes, listing)]).toEqual(['pomerium_config.yaml__config.yaml']);
	});

	test('a trailing slash on either side still matches', () => {
		expect(fileBindKeys(volumes, { ...listing, hostPath: '/data/stacks/pomerium/' }).size).toBe(1);
		expect(fileBindKeys([{ key: 'k', mountType: 'bind', source: '/data/stacks/pomerium/config.yaml/' }], listing).size).toBe(1);
	});

	test('a bind without a known source is skipped, not a crash', () => {
		expect(fileBindKeys([{ key: 'k', mountType: 'bind' }], listing).size).toBe(0);
	});

	test('a named volume that happens to share the path is not marked', () => {
		expect(fileBindKeys([{ key: 'v', mountType: 'volume', source: '/data/stacks/pomerium/config.yaml' }], listing).size).toBe(0);
	});

	test('without a probe listing nothing is marked', () => {
		expect(fileBindKeys(volumes, null).size).toBe(0);
	});
});
