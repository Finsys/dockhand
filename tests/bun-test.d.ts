declare module 'bun:test' {
	type TestCallback = () => void | Promise<void>;

	export function describe(name: string, callback: TestCallback): void;
	export function test(name: string, callback: TestCallback): void;
	export function expect(actual: unknown): {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toContain(expected: unknown): void;
		toThrow(expected?: string | RegExp): void;
	};
}
