import { browser } from '$app/environment';

const DEFAULT_MOBILE_BREAKPOINT = 768;

export class IsMobile {
	#breakpoint: number;
	#current = $state(false);
	#handleResize: (() => void) | null = null;
	#handleMediaChange: ((e: MediaQueryListEvent) => void) | null = null;
	#mql: MediaQueryList | null = null;

	constructor(breakpoint: number = DEFAULT_MOBILE_BREAKPOINT) {
		this.#breakpoint = breakpoint;

		if (browser) {
			// Set initial value
			this.#current = window.innerWidth < this.#breakpoint;

			// Listen for resize events
			this.#handleResize = () => {
				this.#current = window.innerWidth < this.#breakpoint;
			};

			window.addEventListener('resize', this.#handleResize);

			// Also use matchMedia for more reliable detection
			this.#mql = window.matchMedia(`(max-width: ${this.#breakpoint - 1}px)`);
			this.#handleMediaChange = (e: MediaQueryListEvent) => {
				this.#current = e.matches;
			};
			this.#mql.addEventListener('change', this.#handleMediaChange);
		}
	}

	get current() {
		return this.#current;
	}

	destroy() {
		if (this.#handleResize) {
			window.removeEventListener('resize', this.#handleResize);
		}
		if (this.#mql && this.#handleMediaChange) {
			this.#mql.removeEventListener('change', this.#handleMediaChange);
		}
	}
}
