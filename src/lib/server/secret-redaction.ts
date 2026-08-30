/**
 * Minimum length for a secret to be replaced in place. Below it, a value like "test"
 * would match inside unrelated words ("latest", "testing"), so the whole line is
 * withheld instead — we cannot safely tell signal from coincidence.
 */
const MIN_REPLACEABLE_LENGTH = 8;

/** Placeholder written in place of a secret value. */
const PLACEHOLDER = '***';

/**
 * Removes known secret values from a single output line.
 *
 * This does NOT pattern-match "things that look like secrets" — that approach fails for
 * every field nobody thought of. It replaces the exact values we injected ourselves and
 * therefore know.
 *
 * Returns the redacted line, or null when the line must be withheld entirely.
 */
export function redactLine(line: string, secrets: string[]): string | null {
	let result = line;

	for (const secret of secrets) {
		const value = secret?.trim();
		if (!value) continue;

		if (value.length < MIN_REPLACEABLE_LENGTH) {
			// Too short to replace without hitting unrelated substrings. If it appears at all,
			// withhold the line: a false positive costs one hidden line, a false negative leaks.
			if (line.includes(value)) return null;
			continue;
		}

		result = result.split(value).join(PLACEHOLDER);
	}

	return result;
}

/**
 * Bridges a raw line callback to a consumer, applying redaction on the way.
 * Withheld lines (redactLine returning null) are dropped silently — by design:
 * a suppressed line is cheaper than a leaked one.
 */
export function makeLineForwarder(
	consume: (line: string) => void,
	secrets: string[]
): (line: string) => void {
	return (line: string) => {
		const safe = redactLine(line, secrets);
		if (safe !== null) consume(safe);
	};
}

/**
 * Surfaces a final output block as a single redacted line, but ONLY when no line was
 * forwarded during the run (lineCount === 0). Some execution paths (e.g. Hawser's REST
 * call) report only a block, never individual lines -- without this, the operator sees
 * nothing while the run is in progress. A path that already forwarded its own lines
 * (or a future streaming path) must not get the block appended on top: that would show
 * the same text twice.
 */
export function surfaceBlockIfNoLines(
	onLine: ((line: string) => void) | undefined,
	lineCount: number,
	block: string | undefined,
	secrets: string[]
): void {
	if (onLine && lineCount === 0 && block) {
		makeLineForwarder(onLine, secrets)(block);
	}
}

/**
 * A redacting line sink for callers that must also decide, once the run is over, whether to
 * surface the final output block.
 *
 * The two halves belong together because surfaceBlockIfNoLines needs the number of lines that
 * were actually forwarded, and only the sink knows it. Counting what the sender emitted would
 * be wrong: a line withheld by redaction never reached the operator, so for them the block is
 * still the only thing there is to see.
 *
 * `forward` is undefined when there is no consumer, so callers can pass it straight into an
 * optional callback parameter.
 */
export function makeRedactedLineSink(
	onLine: ((line: string) => void) | undefined,
	secrets: string[]
): {
	forward: ((line: string) => void) | undefined;
	surfaceBlock: (block: string | undefined) => void;
} {
	let forwarded = 0;
	const forward = onLine
		? makeLineForwarder((line) => {
				forwarded++;
				onLine(line);
			}, secrets)
		: undefined;

	return {
		forward,
		surfaceBlock: (block) => surfaceBlockIfNoLines(onLine, forwarded, block, secrets)
	};
}
