#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SERVICES = {
  api: { entry: 'packages/api/src/index.ts' },
  ocpp: { entry: 'packages/ocpp/src/start.ts' },
  ocpi: { entry: 'packages/ocpi/src/index.ts' },
  css: { entry: 'packages/css/src/index.ts' },
  worker: { entry: 'packages/worker/src/index.ts' },
  'ocpi-simulator': { entry: 'packages/ocpi-simulator/src/index.ts' },
};

// Packages loaded from node_modules at runtime instead of bundled: native
// addons, and packages that read their own files through __dirname (undefined
// in the ESM bundle), such as pdfkit's font metrics.
export const EXTERNAL = [
  'argon2',
  'pino',
  'pino-pretty',
  '@fastify/swagger-ui',
  'pg-native',
  '@resvg/resvg-js',
  'pdfkit',
];

export const BANNER =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

// Map workspace @evtivity/* imports to source directories so esbuild reads .ts
const WORKSPACE_PACKAGES = {
  '@evtivity/lib': resolve(root, 'packages/lib'),
  '@evtivity/database': resolve(root, 'packages/database'),
  '@evtivity/payments': resolve(root, 'packages/payments'),
  '@evtivity/ocpp': resolve(root, 'packages/ocpp'),
  '@evtivity/api': resolve(root, 'packages/api'),
  '@evtivity/css': resolve(root, 'packages/css'),
  '@evtivity/octt': resolve(root, 'packages/octt'),
  '@evtivity/worker': resolve(root, 'packages/worker'),
};

const workspacePlugin = {
  name: 'workspace-source',
  setup(build) {
    // Intercept @evtivity/* imports and resolve to source .ts files
    build.onResolve({ filter: /^@evtivity\// }, (args) => {
      for (const [pkg, pkgDir] of Object.entries(WORKSPACE_PACKAGES)) {
        if (args.path === pkg) {
          return { path: resolve(pkgDir, 'src/index.ts') };
        }
        if (args.path.startsWith(pkg + '/')) {
          const subpath = args.path.slice(pkg.length + 1);
          const tsPath = subpath.replace(/\.js$/, '.ts');
          const candidates = [
            resolve(pkgDir, 'src', tsPath),
            resolve(pkgDir, tsPath),
            resolve(pkgDir, 'src', `${subpath}.ts`),
          ];
          for (const c of candidates) {
            if (existsSync(c)) return { path: c };
          }
          return { path: candidates[0] };
        }
      }
      return undefined;
    });
  },
};

async function main() {
  const arg = process.argv[2];
  if (!arg || (!SERVICES[arg] && arg !== 'all')) {
    console.error(`Usage: node scripts/build.mjs <${Object.keys(SERVICES).join('|')}|all>`);
    process.exit(1);
  }

  const targets = arg === 'all' ? Object.entries(SERVICES) : [[arg, SERVICES[arg]]];
  const start = Date.now();

  for (const [name, config] of targets) {
    const outfile = resolve(root, `dist/${name}.mjs`);
    const t0 = Date.now();

    await esbuild.build({
      entryPoints: [resolve(root, config.entry)],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile,
      sourcemap: 'linked',
      minify: true,
      treeShaking: true,
      external: EXTERNAL,
      plugins: [workspacePlugin],
      banner: { js: BANNER },
    });

    const ms = Date.now() - t0;
    console.log(`  ${name}: OK (${ms}ms)`);
  }

  const total = Date.now() - start;
  console.log(`\nDone in ${total}ms`);
}

// Build only when run as a script; tests import EXTERNAL and BANNER.
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
