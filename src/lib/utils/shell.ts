/**
 * Parse a shell command string into an array of arguments,
 * respecting single and double quotes.
 *
 * Examples:
 *   "sleep 3600"                → ["sleep", "3600"]
 *   'sh -c "echo hello world"' → ["sh", "-c", "echo hello world"]
 *   "python -c 'print(1)'"     → ["python", "-c", "print(1)"]
 */
export function parseShellCommand(cmd: string): string[] {
	const args: string[] = [];
	let current = '';
	let inQuotes = false;
	let quoteChar = '';

	for (let i = 0; i < cmd.length; i++) {
		const char = cmd[i];

		if ((char === '"' || char === "'") && !inQuotes) {
			inQuotes = true;
			quoteChar = char;
		} else if (char === quoteChar && inQuotes) {
			inQuotes = false;
			quoteChar = '';
		} else if (char === ' ' && !inQuotes) {
			if (current) {
				args.push(current);
				current = '';
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}
