// Deploy-time .env reader. Kept free of server imports so its logging can be unit-tested.
import { expandValue } from '../utils/env-file-values';

/**
 * Redact all env var values for safe logging. Only key names are preserved.
 */
export function redactEnvVarsForLog(vars: Record<string, string>): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const key of Object.keys(vars)) {
		redacted[key] = '***';
	}
	return redacted;
}

/**
 * Parse a .env file content into key-value pairs.
 * Handles comments, empty lines, and quoted values.
 */
export function parseEnvFileContent(
	content: string,
	stackName?: string,
	options?: { expand?: boolean }
): Record<string, string> {
	// Expanding is for a DEPLOY, which needs the values a service will see. A caller
	// showing the file to somebody wants their own text back, references and all -
	// resolving it there would turn ${DIRECTORY} into a path in front of them, and an
	// edit saved from that view would flatten the variable for good.
	const expand = options?.expand !== false;
	const logPrefix = stackName ? `[Stack:${stackName}]` : '[Git]';
	const result: Record<string, string> = {};
	const skippedLines: string[] = [];
	const invalidKeys: string[] = [];

	console.log(`${logPrefix} ----------------------------------------`);
	console.log(`${logPrefix} PARSE ENV FILE CONTENT`);
	console.log(`${logPrefix} ----------------------------------------`);
	// Never log the file itself or any part of a line: .env files hold secrets, and a
	// continuation line of a multi-line value parses as an invalid "key". Only lengths,
	// line numbers, valid keys and the masked values below go to the log.
	console.log(`${logPrefix} Raw content length:`, content.length, 'chars');

	const lines = content.split('\n');
	console.log(`${logPrefix} Total lines:`, lines.length);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) {
			if (trimmed) skippedLines.push(`Line ${i + 1} (comment)`);
			continue;
		}

		// Find the first = sign
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) {
			skippedLines.push(`Line ${i + 1} (no =)`);
			continue;
		}

		const key = trimmed.substring(0, eqIndex).trim();
		const value = trimmed.substring(eqIndex + 1).trim();

		// Only add if key is valid env var name
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			// Quotes are the file's syntax, and a value may refer to an earlier line -
			// both of which compose resolves before a service ever sees the value.
			result[key] = expand ? expandValue(value, result) : value;
		} else {
			invalidKeys.push(`Line ${i + 1} (invalid key format)`);
		}
	}

	console.log(`${logPrefix} Parsed env vars count:`, Object.keys(result).length);
	console.log(`${logPrefix} Parsed env var keys:`, Object.keys(result).join(', '));
	console.log(`${logPrefix} Parsed env vars (masked):`, JSON.stringify(redactEnvVarsForLog(result), null, 2));
	if (skippedLines.length > 0) {
		console.log(`${logPrefix} Skipped lines (${skippedLines.length}):`, skippedLines.slice(0, 10).join('; '));
	}
	if (invalidKeys.length > 0) {
		console.log(`${logPrefix} Invalid keys (${invalidKeys.length}):`, invalidKeys.join('; '));
	}

	return result;
}
