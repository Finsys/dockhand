import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';

const username = 'passkey-admin';
const password = 'correct horse battery staple';
const browserModuleUrl = `/@fs${process.cwd()}/node_modules/@simplewebauthn/browser/esm/index.js`;

test.setTimeout(180_000);

test('register → logout → usernameless Passkey login while preserving recovery and ownership', async ({ page, context, request, browser }) => {
	async function passwordLogin(targetPage: typeof page, loginUsername: string) {
		const result = await targetPage.evaluate(async ({ loginUsername, password }) => {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: loginUsername, password, provider: 'local' })
			});
			return { status: response.status, body: await response.json() };
		}, { loginUsername, password });
		expect(result.status).toBe(200);
		expect(result.body.success).toBe(true);
	}

	async function registerWithVirtualAuthenticator(name: string) {
		return page.evaluate(async ({ name, moduleUrl }) => {
			const { startRegistration } = await import(moduleUrl);
			const optionsResponse = await fetch('/api/auth/passkeys/register/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const optionsData = await optionsResponse.json();
			if (!optionsResponse.ok) return { status: optionsResponse.status, body: optionsData };
			const response = await startRegistration({ optionsJSON: optionsData.options });
			const verifyResponse = await fetch('/api/auth/passkeys/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ceremonyId: optionsData.ceremonyId, response, name })
			});
			return { status: verifyResponse.status, body: await verifyResponse.json() };
		}, { name, moduleUrl: browserModuleUrl });
	}

	async function authenticateWithVirtualAuthenticator() {
		return page.evaluate(async (moduleUrl) => {
			const { startAuthentication } = await import(moduleUrl);
			const optionsResponse = await fetch('/api/auth/passkeys/login/options', { method: 'POST' });
			const optionsData = await optionsResponse.json();
			if (!optionsResponse.ok) return { status: optionsResponse.status, body: optionsData };
			const response = await startAuthentication({ optionsJSON: optionsData.options });
			const verifyResponse = await fetch('/api/auth/passkeys/login/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ceremonyId: optionsData.ceremonyId, response })
			});
			return {
				status: verifyResponse.status,
				body: await verifyResponse.json(),
				challenge: optionsData.options.challenge,
				response
			};
		}, browserModuleUrl);
	}

	const createUser = await request.post('/api/users', {
		data: { username, password, displayName: 'Passkey Admin' }
	});
	expect(createUser.status()).toBe(201);
	const user = await createUser.json();

	const enableAuth = await request.put('/api/auth/settings', { data: { authEnabled: true, defaultProvider: 'local' } });
	expect(enableAuth.ok()).toBe(true);

	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'usb',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});

	await page.goto('/login?redirect=/profile');
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
	await passwordLogin(page, username);
	await page.goto('/profile');
	await page.waitForLoadState('networkidle');
	// Profile can retain an open responsive navigation dialog after authentication.
	// Close it so this test exercises the actual security controls beneath it.
	if (await page.getByRole('dialog').isVisible().catch(() => false)) {
		await page.keyboard.press('Escape');
	}
	const addPasskeyButton = page.getByRole('button', { name: 'Add passkey' });
	const passkeyNameInput = page.getByLabel('Passkey name');
	await expect(addPasskeyButton).toBeDisabled();
	await passkeyNameInput.fill('   ');
	await expect(addPasskeyButton).toBeDisabled();
	const missingName = await page.evaluate(async () => {
		const response = await fetch('/api/auth/passkeys/register/options', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: '   ' })
		});
		return { status: response.status, body: await response.json() };
	});
	expect(missingName.status).toBe(400);
	expect(missingName.body.error).toBe('Enter a Passkey name');

	await passkeyNameInput.fill('Virtual security key');
	await expect(addPasskeyButton).toBeEnabled();
	await addPasskeyButton.click();
	await expect(page.getByText('Virtual security key', { exact: true })).toBeVisible();

	const listed = await page.evaluate(async () => (await fetch('/api/profile/passkeys')).json());
	expect(listed.passkeys).toHaveLength(1);
	expect(listed.passkeys[0].name).toBe('Virtual security key');

	const duplicateName = await registerWithVirtualAuthenticator('  virtual SECURITY KEY  ');
	expect(duplicateName.status).toBe(409);
	expect(duplicateName.body.error).toBe('A Passkey with this name already exists');
	const registeredCredentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
	expect(registeredCredentials.credentials).toHaveLength(1);

	page.once('dialog', async (dialog) => {
		expect(dialog.type()).toBe('confirm');
		expect(dialog.message()).toContain('Virtual security key');
		await dialog.accept();
	});
	await page.getByRole('button', { name: 'Delete Passkey Virtual security key' }).click();
	await expect(page.getByText('Virtual security key', { exact: true })).not.toBeVisible();
	await cdp.send('WebAuthn.removeCredential', {
		authenticatorId,
		credentialId: registeredCredentials.credentials[0].credentialId
	});

	const loginRegistration = await registerWithVirtualAuthenticator('Login security key');
	expect(loginRegistration.status).toBe(200);
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByText('Login security key', { exact: true })).toBeVisible();
	const loginPasskeys = await page.evaluate(async () => (await fetch('/api/profile/passkeys')).json());
	expect(loginPasskeys.passkeys).toHaveLength(1);
	const passkeyId = loginPasskeys.passkeys[0].id as number;

	const apiToken = await page.evaluate(async ({ password }) => {
		const response = await fetch('/api/auth/tokens', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Passkey enrollment isolation test', password })
		});
		return { status: response.status, body: await response.json() };
	}, { password });
	expect(apiToken.status).toBe(201);
	const bearerEnrollment = await request.post('/api/auth/passkeys/register/options', {
		headers: {
			Authorization: `Bearer ${apiToken.body.token}`,
			Origin: 'http://localhost:4173'
		}
	});
	expect(bearerEnrollment.status()).toBe(401);

	const dataDir = process.env.PASSKEY_E2E_DATA_DIR;
	expect(dataDir).toBeTruthy();
	const db = new Database(`${dataDir}/db/dockhand.db`);
	const stored = db.prepare('SELECT * FROM passkey_credentials WHERE id = ?').get(passkeyId) as Record<string, unknown>;
	expect(stored).toBeTruthy();
	expect(stored.name).toBe('Login security key');
	expect(() => db.prepare(`
		INSERT INTO passkey_credentials
		(user_id, credential_id, webauthn_user_id, public_key, counter, device_type, backed_up, name)
		VALUES (?, ?, ?, ?, 0, 'singleDevice', 0, ?)
	`).run(user.id, 'same-user-different-credential', stored.webauthn_user_id, stored.public_key, 'LOGIN SECURITY KEY')).toThrow(/unique/i);

	// The database enforces global credential uniqueness even across users.
	const secondCreate = await page.evaluate(async ({ password }) => {
		const response = await fetch('/api/users', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'passkey-second', password })
		});
		return { status: response.status, body: await response.json() };
	}, { password });
	expect(secondCreate.status).toBe(201);
	expect(() => db.prepare(`
		INSERT INTO passkey_credentials
		(user_id, credential_id, webauthn_user_id, public_key, counter, device_type, backed_up, name)
		VALUES (?, ?, ?, ?, 0, 'singleDevice', 0, 'Other key')
	`).run(secondCreate.body.id, stored.credential_id, 'different-handle', stored.public_key)).toThrow(/unique/i);

	// Cross-user management is scoped by both credential row ID and session user ID.
	const secondContext = await browser.newContext({ baseURL: 'http://localhost:4173' });
	const secondPage = await secondContext.newPage();
	await secondPage.goto('/login?redirect=/profile');
	await secondPage.waitForLoadState('networkidle');
	await passwordLogin(secondPage, 'passkey-second');
	await secondPage.goto('/profile');
	await secondPage.waitForLoadState('networkidle');
	const crossUserDelete = await secondPage.evaluate(async (id) => {
		const response = await fetch(`/api/profile/passkeys/${id}`, { method: 'DELETE' });
		return response.status;
	}, passkeyId);
	expect(crossUserDelete).toBe(404);
	await secondContext.close();

	// Explicit same-origin enforcement rejects a cookie-authenticated cross-origin request.
	const cookie = (await context.cookies()).map((item) => `${item.name}=${item.value}`).join('; ');
	const wrongOrigin = await request.delete(`/api/profile/passkeys/${passkeyId}`, {
		headers: { Cookie: cookie, Origin: 'https://evil.example.test' }
	});
	expect(wrongOrigin.status()).toBe(403);

	async function logout() {
		const result = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status);
		expect(result).toBe(200);
		await page.goto('/login?redirect=/profile');
		await page.waitForLoadState('networkidle');
	}

	async function passkeyLogin() {
		const result = await authenticateWithVirtualAuthenticator();
		expect(result.status).toBe(200);
		expect(result.body.success).toBe(true);
		return result;
	}

	await logout();

	// Inactive users and mismatched discoverable user handles fail closed.
	db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
	const inactiveLogin = await authenticateWithVirtualAuthenticator();
	expect(inactiveLogin.status).toBe(401);
	db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(user.id);

	const originalHandle = stored.webauthn_user_id as string;
	db.prepare('UPDATE passkey_credentials SET webauthn_user_id = ? WHERE id = ?').run('wrong-user-handle', passkeyId);
	const wrongHandleLogin = await authenticateWithVirtualAuthenticator();
	expect(wrongHandleLogin.status).toBe(401);
	db.prepare('UPDATE passkey_credentials SET webauthn_user_id = ? WHERE id = ?').run(originalHandle, passkeyId);

	const counterBefore = Number((db.prepare('SELECT counter FROM passkey_credentials WHERE id = ?').get(passkeyId) as { counter: number }).counter);
	const validLogin = await passkeyLogin();
	const counterAfter = Number((db.prepare('SELECT counter FROM passkey_credentials WHERE id = ?').get(passkeyId) as { counter: number }).counter);
	expect(counterAfter).toBeGreaterThanOrEqual(counterBefore);

	// The same valid assertion is rejected if either configured origin or RP ID is wrong.
	const assertion = validLogin.response as AuthenticationResponseJSON;
	const credentialPublicKey = Uint8Array.from(Buffer.from(stored.public_key as string, 'base64url'));
	await expect(verifyAuthenticationResponse({
		response: assertion, expectedChallenge: validLogin.challenge,
		expectedOrigin: 'https://wrong.example.test', expectedRPID: 'localhost',
		credential: { id: stored.credential_id as string, publicKey: credentialPublicKey, counter: counterBefore },
		requireUserVerification: true
	})).rejects.toThrow();
	await expect(verifyAuthenticationResponse({
		response: assertion, expectedChallenge: validLogin.challenge,
		expectedOrigin: 'http://localhost:4173', expectedRPID: 'wrong.example.test',
		credential: { id: stored.credential_id as string, publicKey: credentialPublicKey, counter: counterBefore },
		requireUserVerification: true
	})).rejects.toThrow();

	// Passkey is sufficient even when the underlying local account has TOTP enabled.
	await logout();
	db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?').run('{"secret":"unused","backupCodes":[]}', user.id);
	await passkeyLogin();
	const session = await page.evaluate(async () => (await fetch('/api/auth/session')).json());
	expect(session.user.provider).toBe('passkey');

	// Logout destroys that normal Dockhand session, and password recovery remains usable.
	await logout();
	const loggedOutSession = await page.evaluate(async () => (await fetch('/api/auth/session')).json());
	expect(loggedOutSession.authenticated).toBe(false);
	db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?').run(user.id);
	await passwordLogin(page, username);
	const recoveredSession = await page.evaluate(async () => (await fetch('/api/auth/session')).json());
	expect(recoveredSession.authenticated).toBe(true);

	// User deletion cascades credentials in SQLite; PostgreSQL uses the same FK migration.
	await page.evaluate(async () => fetch('/api/auth/logout', { method: 'POST' }));
	db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
	const remaining = db.prepare('SELECT count(*) AS count FROM passkey_credentials WHERE user_id = ?').get(user.id) as { count: number };
	expect(remaining.count).toBe(0);
	db.close();
});
