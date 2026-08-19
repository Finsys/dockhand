import { mergeConfig } from 'vite';
import rootConfig from '../../vite.config';

// Layerchart ships TypeScript in .svelte files and is not a JavaScript
// dependency-optimizer target. Keep this test-only exclusion local to E2E.
export default mergeConfig(rootConfig, {
	optimizeDeps: { exclude: ['layerchart'] }
});
