import { beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { registerAuthorizeFake } from './helpers/authorize-fake';
import { registerStacksFake } from './helpers/stacks-fake';

const { GET } = await import('../src/routes/api/stacks/path-hints/+server');
const hints = { workingDir: '/opt/web', configFiles: ['/opt/web/compose.yaml', '/opt/web/override.yml'] };
let authenticated: boolean;
let can: ReturnType<typeof mock>;
let requireEnvAccess: ReturnType<typeof mock>;
let getHints: ReturnType<typeof mock>;

beforeEach(() => {
	authenticated = true;
	can = mock(async () => true);
	requireEnvAccess = mock(async () => null);
	getHints = mock(async () => hints);
	registerAuthorizeFake(async () => ({ authEnabled: true, isAuthenticated: authenticated, can, requireEnvAccess }));
	registerStacksFake('getStackPathHints', getHints);
});

function request(query = 'name=web&env=7') {
	return GET({ url: new URL(`http://localhost/api/stacks/path-hints?${query}`), cookies: {} } as Parameters<typeof GET>[0]);
}

test('requires authentication before validation or hint lookup', async () => {
	authenticated = false;
	const response = await request('env=bad');
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: 'Unauthorized' });
	expect(can).not.toHaveBeenCalled();
	expect(requireEnvAccess).not.toHaveBeenCalled();
	expect(getHints).not.toHaveBeenCalled();
});

test('denied stacks:edit stops before environment access and hint lookup', async () => {
	can.mockResolvedValue(false);
	const response = await request();
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: 'Permission denied' });
	expect(can).toHaveBeenCalledWith('stacks', 'edit', 7);
	expect(requireEnvAccess).not.toHaveBeenCalled();
	expect(getHints).not.toHaveBeenCalled();
});

test('returns environment access denial without looking up hints', async () => {
	const denied = Response.json({ error: 'Environment access denied' }, { status: 403 });
	requireEnvAccess.mockResolvedValue(denied);
	expect(await request()).toBe(denied);
	expect(requireEnvAccess).toHaveBeenCalledWith(7);
	expect(getHints).not.toHaveBeenCalled();
});

test.each(['env=7', 'name=&env=7', ...['', '0', '-1', '1.5', 'abc', '1e2', '0x10', '%207', '9007199254740992'].map(env => `name=web&env=${env}`)])(
	'rejects missing names and invalid environments: %s', async query => {
		const response = await request(query);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: query.startsWith('name=web') ? 'Invalid environment ID' : 'Stack name is required' });
		expect(can).not.toHaveBeenCalled();
		expect(requireEnvAccess).not.toHaveBeenCalled();
		expect(getHints).not.toHaveBeenCalled();
	}
);

test.each([7, undefined])('passes the optional environment through all gates and preserves multifile hints: %s', async env => {
	const response = await request(`name=web${env === undefined ? '' : `&env=${env}`}`);
	expect(response.status).toBe(200);
	expect(can).toHaveBeenCalledWith('stacks', 'edit', env);
	expect(requireEnvAccess).toHaveBeenCalledWith(env);
	expect(getHints).toHaveBeenCalledTimes(1);
	expect(getHints).toHaveBeenCalledWith('web', env);
	expect(await response.json()).toEqual({ stackName: 'web', ...hints });
});

test('surfaces conflicting label errors', async () => {
	getHints.mockRejectedValue(new Error('Conflicting Compose path labels'));
	const log = spyOn(console, 'error').mockImplementation(() => {});
	try {
		const response = await request();
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'Conflicting Compose path labels' });
	} finally { log.mockRestore(); }
});
