/**
 * Render untrusted markdown (GitHub release bodies) to sanitized HTML. The
 * source is arbitrary internet content, so the output is always run through
 * DOMPurify before it reaches an {@html} block.
 */
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
	if (!md) return '';
	const raw = marked.parse(md, { async: false }) as string;
	return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
}
