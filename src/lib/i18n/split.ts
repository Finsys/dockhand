/**
 * Splits a message around its {name} placeholder, so a component can render the
 * name with markup (bold, code) wherever the language puts it:
 * "Restart stack {name}" / "Stack {name} neu starten".
 */
const NAME_MARKER = '\u0000';

export function splitAtName(message: (inputs: { name: string }) => string): [before: string, after: string] {
	const [before, after = ''] = message({ name: NAME_MARKER }).split(NAME_MARKER);
	return [before, after];
}
