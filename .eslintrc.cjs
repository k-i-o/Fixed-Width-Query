/**
 * Layer boundaries, enforced by the linter rather than by good intentions.
 *
 * The dependency graph in docs/00-PROJECT-CONTEXT.md §4.2 is what keeps `core/` testable
 * without VS Code and keeps file-system access out of the webview. A rule that is only
 * written down in a document gets violated the first busy afternoon; these fail the build.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'out', 'node_modules', '*.mjs', '*.cjs'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
    eqeqeq: ['error', 'smart'],
  },
  overrides: [
    {
      // core/ and shared/ are pure: testable with Vitest, no host of any kind.
      files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            { group: ['vscode'], message: 'core/ and shared/ must not depend on the VS Code API.' },
            { group: ['node:*', 'fs', 'path', 'worker_threads'], message: 'core/ and shared/ must not touch Node built-ins. Take bytes as a parameter instead.' },
          ],
        }],
      },
    },
    {
      // Workers run in Node, off the extension host thread, with no API access.
      files: ['src/workers/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{ group: ['vscode'], message: 'Workers run off the extension host and have no VS Code API.' }],
        }],
      },
    },
    {
      // The webview is a sandboxed browser page; the IPC protocol is its only channel.
      files: ['src/webview/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            { group: ['vscode'], message: 'The webview talks to the host through the IPC protocol, never the API directly.' },
            { group: ['node:*', 'fs', 'path', 'worker_threads'], message: 'The webview has no Node runtime.' },
            { group: ['../extension/*'], message: 'The webview must not import extension-host code.' },
          ],
        }],
      },
    },
    {
      // The extension host renders no UI.
      files: ['src/extension/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{ group: ['../webview/*'], message: 'The extension host must not import webview code.' }],
        }],
      },
    },
    {
      files: ['test/**/*.ts'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
  ],
};
