/**
 * Compose output goes to the server log through redactSecretVars, and so does every
 * result the executors return, so deployStack and deployGitStack log redacted output.
 * stacks.ts pulls in the database, so bun cannot load it; these assertions pin the
 * call sites at the source level.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'server', 'stacks.ts'), 'utf8');

describe('compose output in the server log is redacted', () => {
	it('local compose STDOUT and STDERR', () => {
		expect(src).toContain('console.log(redactSecretVars(stdout, secretVars));');
		expect(src).toContain('console.log(redactSecretVars(stderr, secretVars));');
		expect(src).not.toMatch(/console\.log\((stdout|stderr)\);/);
	});

	it('the Hawser response', () => {
		expect(src).toContain('console.log(`${logPrefix} Output:`, redactSecretVars(result.output, secretVars));');
		expect(src).toContain('console.log(`${logPrefix} Error:`, redactSecretVars(result.error, secretVars));');
	});

	it('the exception messages of both executors', () => {
		expect(src).toContain('EXCEPTION in executeLocalCompose:`, redactSecretVars(err.message, secretVars));');
		expect(src).toContain('EXCEPTION in executeComposeViaHawser:`, redactSecretVars(err.message, secretVars));');
	});

	it('the results the executors return, on success and on a timeout', () => {
		expect(src).toContain('output: redactSecretVars(stdout, secretVars),');
		expect(src).toContain('output: redactSecretVars(stdout || stderr, secretVars) || `Stack "${stackName}" ${operation} completed successfully`,');
		expect(src).toContain("output: redactSecretVars(result.output || '', secretVars) || `Stack \"${stackName}\" ${operation} completed via Hawser`,");
		expect(src).not.toMatch(/output: (stdout|result\.output)[ ,|]/);
	});
});

describe('deploy log lines', () => {
	it('the plan is logged with the arguments runsSeparateBuild gets', () => {
		expect(src).toContain('Deploy plan: ${deployPlan(build, build && pullBase, noBuildCache, pullPolicy)}');
		expect(src).toContain('runsSeparateBuild(build, pullBase, noBuildCache)');
	});

	it('a failing stack notification is logged, not swallowed', () => {
		expect(src).toContain('console.error(`[Stack:${name}] ${eventType} notification failed:`');
		const git = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'server', 'git.ts'), 'utf8');
		expect(git).toContain('console.error(`[Stack:${stackName}] git sync notification failed:`');
		expect(git).not.toContain('catch { /* never changes the deploy outcome */ }');
	});

	it('a deploy that stops early (invalid name, name collision) logs and notifies too', () => {
		expect(src).toContain('await notifyStackDeploy(name, envId, invalid, isGitDeploy);\n\t\treturn invalid;');
		const collisions = src.match(/console\.log\(`\$\{logPrefix\} ERROR: \$\{collisionError\}`\);\s*const collision = \{ success: false, output: '', error: collisionError \};\s*await notifyStackDeploy\(name, envId, collision, isGitDeploy\);\s*return collision;/g);
		expect(collisions?.length).toBe(2);
		expect(src).not.toContain("return { success: false, output: '', error: collisionError };");
	});
});

