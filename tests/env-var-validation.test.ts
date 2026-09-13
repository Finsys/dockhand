/**
 * Unit tests for compose environment variable extraction
 * Tests the regex patterns that detect $VAR and ${VAR} references
 */

import { describe, test, expect } from 'bun:test';

// Replicate the extractComposeVars function from the validate endpoint
function extractComposeVars(yaml: string): { required: string[]; optional: string[] } {
	const required: string[] = [];
	const optional: string[] = [];

	const lines = yaml.split('\n');
	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine.startsWith('#')) continue;

		// Match ${VAR_NAME} (required) and ${VAR_NAME:-default} (optional)
		const regex = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-?)[^}]*)?\}/g;
		let match;
		while ((match = regex.exec(line)) !== null) {
			const varName = match[1];
			const hasDefault = match[2] !== undefined;
			if (hasDefault) {
				if (!optional.includes(varName) && !required.includes(varName)) optional.push(varName);
			} else {
				const optIdx = optional.indexOf(varName);
				if (optIdx !== -1) optional.splice(optIdx, 1);
				if (!required.includes(varName)) required.push(varName);
			}
		}

		// Match $VAR_NAME (simple substitution)
		const simpleRegex = /(?<![A-Za-z0-9\$])\$([A-Za-z_][A-Za-z0-9_]*)(?![{A-Za-z0-9_])/g;
		while ((match = simpleRegex.exec(line)) !== null) {
			const varName = match[1];
			if (!required.includes(varName) && !optional.includes(varName)) required.push(varName);
		}
	}

	return { required: required.sort(), optional: optional.sort() };
}

describe('extractComposeVars', () => {
	describe('${VAR} syntax', () => {
		test('detects required ${VAR}', () => {
			const result = extractComposeVars('image: ${IMAGE_NAME}');
			expect(result.required).toContain('IMAGE_NAME');
		});

		test('detects optional ${VAR:-default}', () => {
			const result = extractComposeVars('image: ${IMAGE_NAME:-nginx}');
			expect(result.optional).toContain('IMAGE_NAME');
			expect(result.required).not.toContain('IMAGE_NAME');
		});

		test('${VAR-default} without colon is not detected (known limitation)', () => {
			// Docker Compose supports ${VAR-default} but our regex only handles ${VAR:-default}
			// This is a known gap — the hyphen-only default syntax is rare
			const result = extractComposeVars('image: ${IMAGE_NAME-nginx}');
			expect(result.required).toHaveLength(0);
			expect(result.optional).toHaveLength(0);
		});

		test('multiple vars on one line', () => {
			const result = extractComposeVars('command: ${CMD} --host ${HOST}');
			expect(result.required).toContain('CMD');
			expect(result.required).toContain('HOST');
		});

		test('var used both with and without default is required', () => {
			const yaml = 'image: ${TAG:-latest}\ncommand: ${TAG}';
			const result = extractComposeVars(yaml);
			expect(result.required).toContain('TAG');
			expect(result.optional).not.toContain('TAG');
		});
	});

	describe('$VAR syntax', () => {
		test('detects $VAR at start of value', () => {
			const result = extractComposeVars('image: $IMAGE_NAME');
			expect(result.required).toContain('IMAGE_NAME');
		});

		test('detects $VAR after colon-space', () => {
			const result = extractComposeVars('      - APP_ENV=$APP_ENV');
			expect(result.required).toContain('APP_ENV');
		});
	});

	describe('escaped $$ (literal dollar)', () => {
		test('ignores $$VAR', () => {
			const result = extractComposeVars('command: echo $$HOME');
			expect(result.required).not.toContain('HOME');
		});

		test('ignores $${VAR}', () => {
			const result = extractComposeVars('command: echo $${HOME}');
			expect(result.required).not.toContain('HOME');
		});
	});

	describe('comments', () => {
		test('ignores vars in comments', () => {
			const result = extractComposeVars('# image: ${IMAGE_NAME}');
			expect(result.required).toHaveLength(0);
			expect(result.optional).toHaveLength(0);
		});

		test('ignores vars in indented comments', () => {
			const result = extractComposeVars('    # command: $CMD');
			expect(result.required).toHaveLength(0);
		});
	});

	describe('false positive prevention (#1048)', () => {
		test('does NOT flag $ in middle of value: "1$abcdef1234"', () => {
			const yaml = `
services:
  app:
    environment:
      PASSWORD: "1$abcdef1234"
`;
			const result = extractComposeVars(yaml);
			expect(result.required).not.toContain('abcdef1234');
			expect(result.required).not.toContain('abcdef');
		});

		test('does NOT flag $ preceded by a digit', () => {
			const result = extractComposeVars('value: 123$SECRET');
			expect(result.required).not.toContain('SECRET');
		});

		test('does NOT flag $ preceded by a letter', () => {
			const result = extractComposeVars('value: abc$DEF');
			expect(result.required).not.toContain('DEF');
		});

		test('DOES flag $VAR at start of string', () => {
			const result = extractComposeVars('value: $SECRET');
			expect(result.required).toContain('SECRET');
		});

		test('DOES flag $VAR after space', () => {
			const result = extractComposeVars('value: prefix $SECRET suffix');
			expect(result.required).toContain('SECRET');
		});

		test('DOES flag $VAR after colon', () => {
			const result = extractComposeVars('      - PASS=$DB_PASS');
			expect(result.required).toContain('DB_PASS');
		});

		test('DOES flag $VAR after equals', () => {
			const result = extractComposeVars('      - KEY=$VALUE');
			expect(result.required).toContain('VALUE');
		});

		test('${VAR} in middle of value IS still detected', () => {
			// ${VAR} syntax is always intentional, even mid-value
			const result = extractComposeVars('password: "abc${SECRET}def"');
			expect(result.required).toContain('SECRET');
		});

		test('complex password with multiple $ signs', () => {
			const yaml = `
services:
  db:
    environment:
      MYSQL_ROOT_PASSWORD: "p4$$w0rd$123"
`;
			const result = extractComposeVars(yaml);
			// $$w0rd is escaped (literal $), and $123 starts with a digit so no var name
			expect(result.required).toHaveLength(0);
		});

		test('password with $ before number is not a variable', () => {
			const result = extractComposeVars('PASSWORD: "test$123"');
			// $123 starts with a digit, not a letter — not a valid var name
			expect(result.required).toHaveLength(0);
		});
	});

	describe('gutter marker regex (#1048)', () => {
		// Simulates the client-side gutter marker pattern from CodeEditor.svelte
		function gutterMarkerMatches(line: string, markerName: string): boolean {
			const varPatterns = [
				new RegExp(`(?<!\\$)\\$\\{${markerName}\\}`),
				new RegExp(`(?<!\\$)\\$\\{${markerName}:-`),
				new RegExp(`(?<!\\$)\\$\\{${markerName}-`),
				new RegExp(`(?<!\\$)\\$\\{${markerName}:\\?`),
				new RegExp(`(?<!\\$)\\$\\{${markerName}\\?`),
				new RegExp(`(?<!\\$)\\$\\{${markerName}:\\+`),
				new RegExp(`(?<!\\$)\\$\\{${markerName}\\+`),
				new RegExp(`(?<![A-Za-z0-9\\$])\\$${markerName}(?![a-zA-Z0-9_])`)
			];
			return varPatterns.some((p) => p.test(line));
		}

		test('$VAR at start of value matches', () => {
			expect(gutterMarkerMatches('PASSWORD: $abcdef1234', 'abcdef1234')).toBe(true);
		});

		test('$VAR after space matches', () => {
			expect(gutterMarkerMatches('PASSWORD: "prefix $abcdef1234"', 'abcdef1234')).toBe(true);
		});

		test('$VAR preceded by digit does NOT match', () => {
			expect(gutterMarkerMatches('PASSWORD: "1$abcdef1234"', 'abcdef1234')).toBe(false);
		});

		test('$VAR preceded by letter does NOT match', () => {
			expect(gutterMarkerMatches('PASSWORD: "x$abcdef1234"', 'abcdef1234')).toBe(false);
		});

		test('$$VAR (escaped) does NOT match', () => {
			expect(gutterMarkerMatches('PASSWORD: "$$abcdef1234"', 'abcdef1234')).toBe(false);
		});

		test('${VAR} in middle of value still matches', () => {
			expect(gutterMarkerMatches('PASSWORD: "1${abcdef1234}"', 'abcdef1234')).toBe(true);
		});
	});

	describe('real-world compose snippets', () => {
		test('standard compose with env vars', () => {
			const yaml = `
version: "3.8"
services:
  web:
    image: \${REGISTRY:-docker.io}/\${IMAGE}:\${TAG:-latest}
    ports:
      - "\${PORT:-8080}:80"
    environment:
      - DATABASE_URL=\${DB_URL}
      - APP_ENV=\${APP_ENV:-production}
`;
			const result = extractComposeVars(yaml);
			expect(result.required).toContain('IMAGE');
			expect(result.required).toContain('DB_URL');
			expect(result.optional).toContain('REGISTRY');
			expect(result.optional).toContain('TAG');
			expect(result.optional).toContain('PORT');
			expect(result.optional).toContain('APP_ENV');
		});

		test('frigate compose from issue #1048', () => {
			const yaml = `
services:
  frigate:
    image: ghcr.io/blakeblackshear/frigate:stable
    environment:
      FRIGATE_MQTT_PASSWORD: "1$abcdef1234"
`;
			const result = extractComposeVars(yaml);
			// Should NOT detect "abcdef1234" as a variable
			expect(result.required).toHaveLength(0);
			expect(result.optional).toHaveLength(0);
		});
	});
});
