// Two build targets that must never be mixed:
//   - extension + workers: CommonJS for the Node-based extension host, 'vscode' left external
//   - webview: ESM for a sandboxed Chromium page, no Node built-ins reachable
// Keeping them separate is what makes the layer rules in CLAUDE.md enforceable at build time.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const probe = process.argv.includes('--probe');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  target: 'es2022',
};

/** @type {import('esbuild').BuildOptions} */
const hostConfig = {
  ...common,
  entryPoints: {
    extension: 'src/extension/extension.ts',
    'workers/indexer.worker': 'src/workers/indexer.worker.ts',
    'workers/query.worker': 'src/workers/query.worker.ts',
  },
  outdir: 'dist',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  ...common,
  entryPoints: { main: 'src/webview/main.ts' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'esm',
  loader: { '.css': 'copy' },
};

/** @type {import('esbuild').BuildOptions} */
const cssConfig = {
  ...common,
  entryPoints: { style: 'src/webview/style.css' },
  outdir: 'dist/webview',
  bundle: false,
  loader: { '.css': 'copy' },
};

/**
 * The performance probe. Built into tmp/ rather than dist/ so it never ships inside the
 * .vsix, and only when asked for.
 */
const probeConfig = {
  ...common,
  entryPoints: { probe: 'src/probe/perfProbe.ts' },
  outdir: 'tmp',
  platform: 'node',
  format: 'cjs',
  minify: false,
};

const configs = probe ? [probeConfig] : [hostConfig, webviewConfig, cssConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[fwq] watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('[fwq] build complete');
}
