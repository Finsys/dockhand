export function wrapHtmlLines(html: string): string {
	return html
		.split('\n')
		.map((line) => `<div class="log-line">${line || ' '}</div>`)
		.join('');
}
