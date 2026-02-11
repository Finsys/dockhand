/**
 * Clean PEM content by removing whitespace artifacts from copy/paste.
 * Bun's TLS is strict about PEM format - it fails when certificates have
 * leading/trailing spaces on lines or extra blank lines.
 *
 * @param pem - The PEM content to clean
 * @returns Cleaned PEM content with trimmed lines and no empty lines, or null if empty
 */
export function cleanPem(pem: string | null | undefined): string | null {
	if (!pem) return null;

	const cleaned = pem
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join('\n');

	return cleaned.length > 0 ? cleaned : null;
}
