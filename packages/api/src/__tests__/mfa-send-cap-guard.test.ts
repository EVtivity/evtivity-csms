// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every email or SMS code the API sends goes through the per-account resend
// cap (createAccountMfaChallenge), so no route can send codes without a limit.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === '__integration__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('MFA code send cap', () => {
  it('sends every code through the capped challenge', () => {
    const uncapped = sourceFiles(SRC).filter((file) =>
      /\bcreateMfaChallenge\(/.test(readFileSync(file, 'utf8')),
    );
    expect(uncapped.map((file) => relative(SRC, file))).toEqual([]);
  });
});
