// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Writes `docs-passages.json` (the passages `docs_search` reads) from the
 * website's docs MDX of every locale.
 *
 * Run via: npm run generate:docs-passages -- --docs <website>/app/content/docs --out <file>
 *
 * The docs sync of the release flow runs it on a git archive of the website
 * release branch; the file is never edited by hand.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDocsPassages, serializeDocsPassages } from './services/ai/docs/passages.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name} <path>`);
  }
  return resolve(value);
}

const file = buildDocsPassages(argument('--docs'));
const text = serializeDocsPassages(file);
writeFileSync(argument('--out'), text);
const counts = Object.entries(file.languages).map(
  ([language, pages]) => `${language} ${String(pages.reduce((n, p) => n + p.sections.length, 0))}`,
);
console.log(
  `docs-passages.json: ${String(Math.round(text.length / 1024))} KiB, passages ${counts.join(', ')}`,
);
