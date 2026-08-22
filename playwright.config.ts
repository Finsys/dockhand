import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = join(tmpdir(), 'dockhand-passkey-e2e');
if (process.env.TEST_WORKER_INDEX === undefined) {
	rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
}
process.env.PASSKEY_E2E_DATA_DIR = dataDir;

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/*.pw.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'npm run dev -- --config tests/e2e/vite.config.ts --host 127.0.0.1 --port 4173',
		url: 'http://localhost:4173/api/health',
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			...process.env,
			DATA_DIR: dataDir,
			ORIGIN: 'http://localhost:4173',
			COOKIE_SECURE: 'false'
		}
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
