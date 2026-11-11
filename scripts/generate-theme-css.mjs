#!/usr/bin/env node
/**
 * Writes the generated theme tokens of the CSMS and the portal
 * (`packages/<app>/src/themes.css`) from @evtivity/lib/ui-theme-tokens.
 * Run with `npm run codegen:themes` after a token change; the lib test
 * `ui-theme.test.ts` fails while a generated file differs.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderThemeCss } from '../packages/lib/src/ui-theme-tokens.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = renderThemeCss();
for (const app of ['csms', 'portal']) {
  const file = resolve(root, `packages/${app}/src/themes.css`);
  writeFileSync(file, css);
  console.log(`wrote ${file}`);
}
