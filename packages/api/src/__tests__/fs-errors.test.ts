// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { isMissingFileError } from '../lib/fs-errors.js';

describe('isMissingFileError', () => {
  it('matches the error of a file that does not exist', async () => {
    const err: unknown = await readFile('/nonexistent/evtivity-fs-errors-test').catch(
      (e: unknown) => e,
    );
    expect(isMissingFileError(err)).toBe(true);
  });

  it('does not match other errors', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(isMissingFileError(denied)).toBe(false);
    expect(isMissingFileError(new Error('plain'))).toBe(false);
    expect(isMissingFileError({ code: 'ENOENT' })).toBe(false);
  });
});
