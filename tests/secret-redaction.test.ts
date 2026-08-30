import { describe, test, expect } from 'bun:test';
import { redactLine } from '../src/lib/server/secret-redaction';

describe('redactLine', () => {
	test('ersetzt einen bekannten Wert exakt', () => {
		const line = 'Error: connection to postgres://user:sup3rgeheim-passwort-42@db failed';
		expect(redactLine(line, ['sup3rgeheim-passwort-42'])).toBe(
			'Error: connection to postgres://user:***@db failed'
		);
	});

	test('ersetzt jedes Vorkommen, nicht nur das erste', () => {
		expect(redactLine('a=tokenwert-lang-genug b=tokenwert-lang-genug', ['tokenwert-lang-genug'])).toBe(
			'a=*** b=***'
		);
	});

	test('haelt die ganze Zeile zurueck, wenn ein Geheimnis zu kurz zum sicheren Ersetzen ist', () => {
		// "test" wuerde in "latest", "testing", "attest" zutreffen -- Ersetzen waere Unsinn
		expect(redactLine('Pulling image alpine:latest', ['test'])).toBeNull();
	});

	test('laesst eine Zeile ohne Geheimnis unveraendert', () => {
		const line = 'Container app-1  Started';
		expect(redactLine(line, ['sup3rgeheim-passwort-42'])).toBe(line);
	});

	test('ignoriert leere und undefinierte Geheimnisse', () => {
		const line = 'Container app-1  Started';
		expect(redactLine(line, ['', '  '])).toBe(line);
	});
});
