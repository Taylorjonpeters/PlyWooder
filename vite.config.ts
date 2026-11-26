import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// The short commit hash names the exact build. A build outside git has none.
let build = '';
try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git checkout */ }

export default defineConfig({
  // Relative asset paths, so the build works from a GitHub Pages project URL (/PlyWooder/).
  base: './',
  worker: { format: 'es' },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_BUILD__: JSON.stringify(build),
  },
});
