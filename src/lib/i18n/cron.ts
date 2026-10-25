/** cronstrue (the human-readable cron description) in the UI language. */
import { getLocale } from '$lib/paraglide/runtime.js';
import { cronstrueLocaleFor } from './cron-core';

export function cronstrueLocale(): string {
	return cronstrueLocaleFor(getLocale());
}
