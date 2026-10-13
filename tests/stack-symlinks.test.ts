/**
 * A repository's symlinks decide whether a stack can be deployed twice (a resolved link
 * points back at its own source the second time, and so does a link to its own
 * ancestor), and whether the repository can reach outside itself through a link the
 * deploy copies.
 */
import { describe, test, expect } from 'bun:test';
import { judgeSymlink } from '../src/lib/server/stack-symlinks';

const ROOT = '/app/data/git-repos/local/mystack';

describe('judgeSymlink', () => {
	test('carries a relative link to a sibling directory', () => {
		expect(judgeSymlink(`${ROOT}/link-dir`, 'real-dir', ROOT)).toEqual({ kind: 'carry', target: 'real-dir' });
	});

	test('carries a link that walks up and back down inside the stack', () => {
		// .claude/skills/x -> ../../.agents/skills/x, a common agent-skill layout.
		expect(judgeSymlink(`${ROOT}/.claude/skills/ask-matt`, '../../.agents/skills/ask-matt', ROOT).kind).toBe('carry');
	});

	test('carries a link to a file in a sibling directory', () => {
		expect(judgeSymlink(`${ROOT}/cfg.conf`, 'configs/keep.conf', ROOT).kind).toBe('carry');
	});

	test('refuses a link to the stack root, which contains the link', () => {
		const v = judgeSymlink(`${ROOT}/here`, '.', ROOT);
		expect(v.kind).toBe('refuse');
		expect(v.kind === 'refuse' && v.reason).toContain('contains the link itself');
	});

	test('refuses a link to its own parent', () => {
		// Measured: the one shape that still fails the second copy when carried verbatim.
		const v = judgeSymlink(`${ROOT}/sub/up`, '..', ROOT);
		expect(v.kind).toBe('refuse');
		expect(v.kind === 'refuse' && v.reason).toContain('contains the link itself');
	});

	test('refuses a link to a grandparent inside the stack', () => {
		expect(judgeSymlink(`${ROOT}/a/b/up`, '../..', ROOT).kind).toBe('refuse');
	});

	test('carries a link to a SIBLING of its own directory, which is not an ancestor', () => {
		// The near miss for the ancestor rule: one level up and back down is fine.
		expect(judgeSymlink(`${ROOT}/a/b/over`, '../c', ROOT).kind).toBe('carry');
	});

	test('refuses a link that climbs out of the stack', () => {
		const v = judgeSymlink(`${ROOT}/escape`, '../other-stack', ROOT);
		expect(v.kind).toBe('refuse');
		expect(v.kind === 'refuse' && v.reason).toContain('outside the stack directory');
	});

	test('refuses a link that climbs far out', () => {
		expect(judgeSymlink(`${ROOT}/escape`, '../../../../etc', ROOT).kind).toBe('refuse');
	});

	test('refuses an absolute target even when it points inside the stack', () => {
		// Valid only for this one directory: a remote deploy or a restore elsewhere gives
		// the link a different root, and it then points at nothing.
		const v = judgeSymlink(`${ROOT}/abs`, `${ROOT}/real-dir`, ROOT);
		expect(v.kind).toBe('refuse');
		expect(v.kind === 'refuse' && v.reason).toContain('absolute path');
	});

	test('refuses an absolute target outside the stack', () => {
		expect(judgeSymlink(`${ROOT}/pw`, '/etc/passwd', ROOT).kind).toBe('refuse');
	});

	test('a target that merely shares the root prefix is still outside', () => {
		// /mystack-other is not under /mystack, despite the string prefix.
		expect(judgeSymlink(`${ROOT}/sneaky`, '../mystack-other/file', ROOT).kind).toBe('refuse');
	});

	test('the second hop of a chain is judged on its own, not followed', () => {
		// leak -> out/secret.txt reads as inside the stack. It is carried, and that is
		// safe only because the copy refuses the first hop and nothing here follows a
		// link. Reading THROUGH a link would need realpath; nothing does.
		expect(judgeSymlink(`${ROOT}/leak`, 'out/secret.txt', ROOT).kind).toBe('carry');
		expect(judgeSymlink(`${ROOT}/out`, '../secret', ROOT).kind).toBe('refuse');
	});
});
