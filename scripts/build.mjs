import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * Bundle the action into a single committed file.
 *
 * A JavaScript action runs straight from the repository with no install step, so
 * every dependency has to be in the file the runner executes. The output is CommonJS
 * with a `.cjs` extension: this package is ESM, and `@actions/*` and its Octokit
 * dependencies are still CommonJS, so bundling down is the shape with the fewest
 * ways to break at three in the morning on someone else's runner.
 */
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  bundle: true,
  platform: 'node',
  // Matches `runs.using: node24` in action.yml.
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
});

console.log('Bundled dist/index.cjs');
