/**
 * backups/error-message.ts — turn restic / Docker error text into a readable
 * sentence for the UI. Pure and dependency-free so it is unit-testable directly.
 *
 * The inputs are messy: ANSI colour codes, a whole JSON error object, an error
 * with embedded JSON, and the worst case — a KILLED helper whose "Container
 * exited with code N:" detail is followed by several restic `--json` PROGRESS
 * lines glued together (no error `message` in any of them). Each case collapses
 * to the shortest true, readable string.
 */

/**
 * cleanErrorMsg is on the error path — it must NEVER throw and become the crash it
 * was meant to describe. Coerce any non-string to its raw string, and wrap the whole
 * parse in a try/catch that falls back to the raw input. We never fabricate a message:
 * raw text is always better than swallowing the real error.
 */
export function cleanErrorMsg(msg: unknown): string {
	const raw = typeof msg === 'string' ? msg : safeString(msg);
	try {
		return clean(raw);
	} catch {
		// Any unforeseen failure in parsing → return the raw string untouched.
		return raw;
	}
}

/** Coerce anything to a string without ever throwing (a hostile toString() can). */
function safeString(v: unknown): string {
	try { return String(v); } catch { return ''; }
}

function clean(msg: string): string {
	// Strip ANSI escape codes
	const clean = msg.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
	// Try parsing the whole string as JSON
	try { const p = JSON.parse(clean); if (typeof p?.message === 'string' && p.message) return p.message; } catch { /* not pure JSON */ }
	// Try extracting embedded JSON — replace real newlines so JSON.parse works
	const jsonStart = clean.indexOf('{');
	const jsonEnd = clean.lastIndexOf('}');
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		try {
			const jsonStr = clean.slice(jsonStart, jsonEnd + 1).replace(/\n/g, '\\n');
			const parsed = JSON.parse(jsonStr);
			// Only a STRING message is usable — a number/object would cast to "123"
			// or "[object Object]", which is worse than the raw text.
			if (typeof parsed?.message === 'string' && parsed.message) {
				const prefix = clean.slice(0, jsonStart).trim();
				const message = parsed.message.replace(/\\n/g, ' ').trim();
				return prefix ? `${prefix} ${message}` : message;
			}
			if (parsed.message_type) {
				// A killed helper appends restic's last --json PROGRESS line
				// (message_type, no `message`) to the exit-code detail — no error
				// text; drop it, keep just the readable prefix.
				const p2 = clean.slice(0, jsonStart).trim().replace(/:\s*$/, '');
				if (p2) return p2;
			}
		} catch {
			// The whole slice didn't parse as one JSON - which is what a KILLED helper
			// produces: "Container exited with code N: {progress} {progress} ...",
			// several restic --json PROGRESS lines concatenated after the exit detail.
			// None carry an error message; keep just the readable prefix before them.
			if (/^\{.*"message_type"/.test(clean.slice(jsonStart, jsonStart + 200))) {
				const p3 = clean.slice(0, jsonStart).trim().replace(/:\s*$/, '');
				if (p3) return p3;
			}
		}
	}
	return clean;
}
