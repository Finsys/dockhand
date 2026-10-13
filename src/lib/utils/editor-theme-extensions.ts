import type { Extension } from '@codemirror/state';
import * as uiw from '@uiw/codemirror-themes-all';

// id -> CM6 theme Extension (#1309). Heavy (pulls the whole @uiw theme package), so this
// module is imported ONLY client-side (CodeEditor / EditorThemeSelector). 'default' maps
// to null - CodeEditor then uses its built-in dark/light theme that follows the app toggle.
// Keys must match the ids in editor-themes.ts.
const EXTENSIONS: Record<string, Extension> = {
	dracula: uiw.dracula,
	'vscode-dark': uiw.vscodeDark,
	'github-dark': uiw.githubDark,
	monokai: uiw.monokai,
	'monokai-dimmed': uiw.monokaiDimmed,
	nord: uiw.nord,
	'tokyo-night': uiw.tokyoNight,
	'tokyo-night-storm': uiw.tokyoNightStorm,
	'solarized-dark': uiw.solarizedDark,
	'gruvbox-dark': uiw.gruvboxDark,
	'material-dark': uiw.materialDark,
	'atom-one': uiw.atomone,
	androidstudio: uiw.androidstudio,
	andromeda: uiw.andromeda,
	aura: uiw.aura,
	abcdef: uiw.abcdef,
	abyss: uiw.abyss,
	bespin: uiw.bespin,
	copilot: uiw.copilot,
	darcula: uiw.darcula,
	'duotone-dark': uiw.duotoneDark,
	kimbie: uiw.kimbie,
	okaidia: uiw.okaidia,
	red: uiw.red,
	sublime: uiw.sublime,
	'console-dark': uiw.consoleDark,
	'tomorrow-night-blue': uiw.tomorrowNightBlue,
	'white-dark': uiw.whiteDark,
	'xcode-dark': uiw.xcodeDark,
	material: uiw.material,
	'basic-dark': uiw.basicDark,

	'github-light': uiw.githubLight,
	'vscode-light': uiw.vscodeLight,
	'solarized-light': uiw.solarizedLight,
	'gruvbox-light': uiw.gruvboxLight,
	'material-light': uiw.materialLight,
	'duotone-light': uiw.duotoneLight,
	eclipse: uiw.eclipse,
	bbedit: uiw.bbedit,
	'noctis-lilac': uiw.noctisLilac,
	quietlight: uiw.quietlight,
	'tokyo-night-day': uiw.tokyoNightDay,
	'xcode-light': uiw.xcodeLight,
	'console-light': uiw.consoleLight,
	'white-light': uiw.whiteLight
};

// Returns the CM6 theme extension for an id, or null for 'default'/unknown (built-in theme).
export function getEditorThemeExtension(id: string | undefined | null): Extension | null {
	if (!id || id === 'default') return null;
	return EXTENSIONS[id] ?? null;
}
