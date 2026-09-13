/**
 * Pure parser for docker compose output shown in the error dialog. Extracted from
 * error-dialog.svelte so it can be unit-tested (a .svelte script block can't be
 * imported directly). The component imports parseDockerOutput from here.
 */

export interface ParsedStep {
	action: string;
	status: 'creating' | 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'removing' | 'removed' | 'error';
}

export interface ParsedOutput {
	warnings: string[];
	steps: ParsedStep[];
	error: string | null;
	raw: string;
	parsed: boolean;
}

export function parseDockerOutput(text: string): ParsedOutput {
	const result: ParsedOutput = {
		warnings: [],
		steps: [],
		error: null,
		raw: text,
		parsed: false
	};

	try {
		const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

		for (const line of lines) {
			// Parse time="..." level=warning msg="..."
			// msg often contains escaped quotes, e.g. msg="The \"FOO\" variable is not set.",
			// so the capture must allow \" (and \\) inside - a plain [^"]+ stops at the
			// first \" and shows a truncated "The \". Un-escape before display.
			const warningMatch = line.match(/time="[^"]*"\s+level=warning\s+msg="((?:\\.|[^"\\])*)"/);
			if (warningMatch) {
				result.warnings.push(warningMatch[1].replace(/\\(["\\])/g, '$1'));
				result.parsed = true;
				continue;
			}

			// Parse container/network steps: "Network foo Creating" or "Container foo-1 Created"
			const stepMatch = line.match(
				/^\s*(Network|Container|Volume)\s+(\S+)\s+(Creating|Created|Starting|Started|Stopping|Stopped|Removing|Removed)\s*$/i
			);
			if (stepMatch) {
				const [, type, name, status] = stepMatch;
				result.steps.push({
					action: `${type} ${name}`,
					status: status.toLowerCase() as ParsedStep['status']
				});
				result.parsed = true;
				continue;
			}

			// Parse error lines
			if (line.startsWith('Error') || line.includes('error') || line.includes('failed')) {
				result.error = result.error ? `${result.error}\n${line}` : line;
				result.parsed = true;
				continue;
			}
		}

		// If we parsed something but have no clear error, check for remaining unparsed content
		if (result.parsed && !result.error) {
			const unparsed = lines.filter((line) => {
				if (line.match(/time="[^"]*"\s+level=warning/)) return false;
				if (
					line.match(
						/^\s*(Network|Container|Volume)\s+\S+\s+(Creating|Created|Starting|Started|Stopping|Stopped|Removing|Removed)\s*$/i
					)
				)
					return false;
				return true;
			});
			if (unparsed.length > 0) {
				result.error = unparsed.join('\n');
			}
		}
	} catch {
		// Parsing failed, will show raw message
	}

	return result;
}
