/**
 * Theme and Font Metadata for Dockhand
 *
 * Color values are defined in app.css as CSS classes.
 * This file only contains metadata for UI selectors.
 *
 * Theme colors are sourced from official theme specifications:
 * - Catppuccin: https://catppuccin.com/palette/
 * - Nord: https://www.nordtheme.com/
 * - Dracula: https://draculatheme.com/spec
 * - Gruvbox: https://github.com/morhetz/gruvbox
 * - Solarized: https://ethanschoonover.com/solarized/
 * - One Dark: https://github.com/atom/one-dark-syntax
 * - Rose Pine: https://rosepinetheme.com/palette/
 * - Tokyo Night: https://github.com/tokyo-night/tokyo-night-vscode-theme
 * - GitHub: https://primer.style/primitives/colors
 * - Material: https://material.io/design/color
 * - Monokai: https://monokai.pro/
 * - Palenight: https://github.com/whizkydee/vscode-palenight-theme
 */

export interface ThemeMeta {
	id: string;
	name: string;
	preview: string; // Primary/accent color for swatch preview (hex)
}

export interface FontMeta {
	id: string;
	name: string;
	family: string;
	googleFont?: string; // Only loaded when selected (on-demand)
}

// Light theme options - colors defined in app.css
export const lightThemes: ThemeMeta[] = [
	{ id: 'default', name: 'Default', preview: '#3b82f6' },
	{ id: 'catppuccin', name: 'Catppuccin Latte', preview: '#8839ef' }, // Mauve
	{ id: 'rose-pine', name: 'Rose Pine Dawn', preview: '#907aa9' }, // Iris
	{ id: 'nord', name: 'Nord Light', preview: '#5e81ac' }, // Nord10
	{ id: 'solarized', name: 'Solarized Light', preview: '#268bd2' }, // Blue
	{ id: 'gruvbox', name: 'Gruvbox Light', preview: '#458588' }, // Aqua
	{ id: 'alucard', name: 'Alucard (Dracula Light)', preview: '#644ac9' }, // Purple
	{ id: 'github', name: 'GitHub Light', preview: '#0969da' }, // Blue
	{ id: 'material', name: 'Material Light', preview: '#00acc1' }, // Cyan
	{ id: 'atom-one', name: 'Atom One Light', preview: '#4078f2' } // Blue
];

// Dark theme options - colors defined in app.css
export const darkThemes: ThemeMeta[] = [
	{ id: 'default', name: 'Default', preview: '#3b82f6' },
	{ id: 'catppuccin', name: 'Catppuccin Mocha', preview: '#cba6f7' }, // Mauve
	{ id: 'dracula', name: 'Dracula', preview: '#bd93f9' }, // Purple
	{ id: 'rose-pine', name: 'Rose Pine', preview: '#c4a7e7' }, // Iris
	{ id: 'rose-pine-moon', name: 'Rose Pine Moon', preview: '#c4a7e7' }, // Iris
	{ id: 'tokyo-night', name: 'Tokyo Night', preview: '#7aa2f7' }, // Blue
	{ id: 'nord', name: 'Nord', preview: '#81a1c1' }, // Nord9
	{ id: 'one-dark', name: 'One Dark', preview: '#61afef' }, // Blue
	{ id: 'gruvbox', name: 'Gruvbox Dark', preview: '#b8bb26' }, // Green
	{ id: 'solarized', name: 'Solarized Dark', preview: '#268bd2' }, // Blue
	{ id: 'everforest', name: 'Everforest', preview: '#a7c080' }, // Green
	{ id: 'kanagawa', name: 'Kanagawa', preview: '#7e9cd8' }, // Blue
	{ id: 'monokai', name: 'Monokai', preview: '#f92672' }, // Pink
	{ id: 'monokai-pro', name: 'Monokai Pro', preview: '#ff6188' }, // Pink
	{ id: 'material', name: 'Material Dark', preview: '#80cbc4' }, // Teal
	{ id: 'palenight', name: 'Palenight', preview: '#c792ea' }, // Purple
	{ id: 'github', name: 'GitHub Dark', preview: '#58a6ff' } // Blue
];

// Font options - Google Fonts loaded on-demand, not kept in memory
export const fonts: FontMeta[] = [
	// System fonts (no external load)
	{ id: 'system', name: 'System UI', family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },

	// Modern geometric sans-serif
	{ id: 'geist', name: 'Geist', family: "'Geist', sans-serif", googleFont: 'Geist:wght@400;500;600;700' },
	{ id: 'inter', name: 'Inter', family: "'Inter', sans-serif", googleFont: 'Inter:wght@400;500;600;700' },
	{ id: 'plus-jakarta', name: 'Plus Jakarta Sans', family: "'Plus Jakarta Sans', sans-serif", googleFont: 'Plus+Jakarta+Sans:wght@400;500;600;700' },
	{ id: 'dm-sans', name: 'DM Sans', family: "'DM Sans', sans-serif", googleFont: 'DM+Sans:wght@400;500;600;700' },
	{ id: 'outfit', name: 'Outfit', family: "'Outfit', sans-serif", googleFont: 'Outfit:wght@400;500;600;700' },
	{ id: 'space-grotesk', name: 'Space Grotesk', family: "'Space Grotesk', sans-serif", googleFont: 'Space+Grotesk:wght@400;500;600;700' },

	// Humanist sans-serif
	{ id: 'sofia-sans', name: 'Sofia Sans', family: "'Sofia Sans', sans-serif", googleFont: 'Sofia+Sans:wght@400;500;600;700' },
	{ id: 'nunito', name: 'Nunito', family: "'Nunito', sans-serif", googleFont: 'Nunito:wght@400;500;600;700' },
	{ id: 'poppins', name: 'Poppins', family: "'Poppins', sans-serif", googleFont: 'Poppins:wght@400;500;600;700' },
	{ id: 'montserrat', name: 'Montserrat', family: "'Montserrat', sans-serif", googleFont: 'Montserrat:wght@400;500;600;700' },
	{ id: 'raleway', name: 'Raleway', family: "'Raleway', sans-serif", googleFont: 'Raleway:wght@400;500;600;700' },
	{ id: 'manrope', name: 'Manrope', family: "'Manrope', sans-serif", googleFont: 'Manrope:wght@400;500;600;700' },

	// Classic sans-serif
	{ id: 'roboto', name: 'Roboto', family: "'Roboto', sans-serif", googleFont: 'Roboto:wght@400;500;600;700' },
	{ id: 'open-sans', name: 'Open Sans', family: "'Open Sans', sans-serif", googleFont: 'Open+Sans:wght@400;500;600;700' },
	{ id: 'lato', name: 'Lato', family: "'Lato', sans-serif", googleFont: 'Lato:wght@400;700' },
	{ id: 'source-sans', name: 'Source Sans 3', family: "'Source Sans 3', sans-serif", googleFont: 'Source+Sans+3:wght@400;500;600;700' },
	{ id: 'work-sans', name: 'Work Sans', family: "'Work Sans', sans-serif", googleFont: 'Work+Sans:wght@400;500;600;700' },
	{ id: 'fira-sans', name: 'Fira Sans', family: "'Fira Sans', sans-serif", googleFont: 'Fira+Sans:wght@400;500;600;700' },

	// Monospace (for a techy look)
	{ id: 'jetbrains-mono', name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", googleFont: 'JetBrains+Mono:wght@400;500;600;700' },
	{ id: 'fira-code', name: 'Fira Code', family: "'Fira Code', monospace", googleFont: 'Fira+Code:wght@400;500;600;700' },

	// Rounded/friendly
	{ id: 'quicksand', name: 'Quicksand', family: "'Quicksand', sans-serif", googleFont: 'Quicksand:wght@400;500;600;700' },
	{ id: 'comfortaa', name: 'Comfortaa', family: "'Comfortaa', sans-serif", googleFont: 'Comfortaa:wght@400;500;600;700' }
];

// Monospace fonts for terminal, logs, and editors
export const monospaceFonts: FontMeta[] = [
	// System monospace (no external load)
	{ id: 'system-mono', name: 'System Monospace', family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },

	// Popular coding fonts (Google Fonts)
	{ id: 'jetbrains-mono', name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", googleFont: 'JetBrains+Mono:wght@400;500;600;700' },
	{ id: 'fira-code', name: 'Fira Code', family: "'Fira Code', monospace", googleFont: 'Fira+Code:wght@400;500;600;700' },
	{ id: 'source-code-pro', name: 'Source Code Pro', family: "'Source Code Pro', monospace", googleFont: 'Source+Code+Pro:wght@400;500;600;700' },
	{ id: 'cascadia-code', name: 'Cascadia Code', family: "'Cascadia Code', monospace", googleFont: 'Cascadia+Code:wght@400;500;600;700' },
	{ id: 'ibm-plex-mono', name: 'IBM Plex Mono', family: "'IBM Plex Mono', monospace", googleFont: 'IBM+Plex+Mono:wght@400;500;600;700' },
	{ id: 'roboto-mono', name: 'Roboto Mono', family: "'Roboto Mono', monospace", googleFont: 'Roboto+Mono:wght@400;500;600;700' },
	{ id: 'ubuntu-mono', name: 'Ubuntu Mono', family: "'Ubuntu Mono', monospace", googleFont: 'Ubuntu+Mono:wght@400;700' },
	{ id: 'space-mono', name: 'Space Mono', family: "'Space Mono', monospace", googleFont: 'Space+Mono:wght@400;700' },
	{ id: 'inconsolata', name: 'Inconsolata', family: "'Inconsolata', monospace", googleFont: 'Inconsolata:wght@400;500;600;700' },
	{ id: 'hack', name: 'Hack', family: "'Hack', monospace", googleFont: 'Hack:wght@400;700' },
	{ id: 'anonymous-pro', name: 'Anonymous Pro', family: "'Anonymous Pro', monospace", googleFont: 'Anonymous+Pro:wght@400;700' },
	{ id: 'dm-mono', name: 'DM Mono', family: "'DM Mono', monospace", googleFont: 'DM+Mono:wght@400;500' },
	{ id: 'red-hat-mono', name: 'Red Hat Mono', family: "'Red Hat Mono', monospace", googleFont: 'Red+Hat+Mono:wght@400;500;600;700' },

	// Platform-specific (no external load)
	{ id: 'menlo', name: 'Menlo', family: 'Menlo, Monaco, monospace' },
	{ id: 'consolas', name: 'Consolas', family: 'Consolas, monospace' },
	{ id: 'sf-mono', name: 'SF Mono', family: '"SF Mono", SFMono-Regular, monospace' }
];

export function getFont(id: string): FontMeta | undefined {
	return fonts.find((f) => f.id === id);
}

export function getMonospaceFont(id: string): FontMeta | undefined {
	return monospaceFonts.find((f) => f.id === id);
}

export function getLightTheme(id: string): ThemeMeta | undefined {
	return lightThemes.find((t) => t.id === id);
}

export function getDarkTheme(id: string): ThemeMeta | undefined {
	return darkThemes.find((t) => t.id === id);
}
