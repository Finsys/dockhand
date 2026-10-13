import { describe, expect, test } from 'bun:test';
import {
	protonTokenFormatError,
	passCliFailureReason
} from '../src/lib/server/secretproviders/proton-token-core';

/**
 * Token shape and failure reporting for Proton Pass.
 *
 * The rules mirror pass-auth's parser; they were checked against the real
 * pass-cli 2.4.1 binary, including that a padded base64 key is rejected by it
 * too (it fails in ~40ms, locally, where a well-formed key reaches the network
 * and takes ~400ms).
 */

const BODY = 'a'.repeat(64);
const VALID = `pst_${BODY}::QUJDREVG`;

describe('protonTokenFormatError', () => {
	test('accepts the documented shape', () => {
		expect(protonTokenFormatError(VALID)).toBeNull();
		// base64url uses - and _ rather than + and /
		expect(protonTokenFormatError(`pst_${BODY}::ab-_09AZ`)).toBeNull();
	});

	test('rejects a token with no key half', () => {
		// The half after :: is what the reporter would lose by copying partially.
		const err = protonTokenFormatError(`pst_${BODY}`);
		expect(err).toContain('pst_<token>::<key>');
	});

	test('rejects a wrong prefix', () => {
		expect(protonTokenFormatError(`tok_${BODY}::QUJD`)).toContain('pst_');
	});

	test('rejects a body that is not 64 characters', () => {
		expect(protonTokenFormatError('pst_abc::QUJD')).toContain('64 characters');
		expect(protonTokenFormatError(`pst_${'a'.repeat(63)}::QUJD`)).toContain('64 characters');
		expect(protonTokenFormatError(`pst_${'a'.repeat(65)}::QUJD`)).toContain('64 characters');
	});

	test('rejects a key that is not base64url', () => {
		// pass-cli decodes URL_SAFE_NO_PAD, so padding and + / are not valid.
		expect(protonTokenFormatError(`pst_${BODY}::QUJD==`)).toContain('base64url');
		expect(protonTokenFormatError(`pst_${BODY}::QU+D/x`)).toContain('base64url');
		expect(protonTokenFormatError(`pst_${BODY}::`)).toContain('base64url');
	});

	test('rejects an empty or whitespace-bearing token', () => {
		expect(protonTokenFormatError('')).toContain('empty');
		expect(protonTokenFormatError(`pst_${'a'.repeat(63)} ::QUJD`)).toContain('whitespace');
	});

	test('rejects more than one separator', () => {
		expect(protonTokenFormatError(`pst_${BODY}::QUJD::extra`)).toContain('pst_<token>::<key>');
	});
});

describe('passCliFailureReason', () => {
	// Verbatim from pass-cli 2.4.1 on a rejected token.
	const REAL_STDERR = [
		'Error: Error in personal access token login flow',
		'',
		'Caused by:',
		'    0: Error creating personal access token session',
		'    1: This personal access token is invalid, expired or has been deleted.',
		''
	].join('\n');

	test('reports a known cause, not the generic wrapper around it', () => {
		expect(passCliFailureReason(REAL_STDERR)).toBe(
			'This personal access token is invalid, expired or has been deleted.'
		);
	});

	test('repeats nothing it does not recognise', () => {
		// stderr can carry an item name, a path, or secret output from a failed
		// write, so an unknown line is dropped rather than shown.
		expect(passCliFailureReason('raw stderr pst_secrettoken::KEY more-secret')).toBeNull();
		expect(passCliFailureReason('something went wrong')).toBeNull();
		expect(passCliFailureReason('Error: Error in personal access token login flow')).toBeNull();
	});

	test('never repeats a secret that shares a line with a known cause', () => {
		// The cause is matched and returned whole; the rest of the line stays out.
		const noisy = 'token=pst_leak::KEY Already authenticated extra-secret';
		expect(passCliFailureReason(noisy)).toBe('Already authenticated');
	});

	test('has nothing to report for empty output', () => {
		expect(passCliFailureReason('')).toBeNull();
		expect(passCliFailureReason('\n\n  \n')).toBeNull();
	});
});
