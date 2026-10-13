// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import { noRawClipboard } from './no-raw-clipboard.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run('no-raw-clipboard', noRawClipboard, {
  valid: [
    '<CopyButton value={id} />',
    'void copyText(url);',
    'const files = Array.from(e.clipboardData.files);',
    'navigator.language;',
    'state.clipboard.writeText(text);',
  ],
  invalid: [
    {
      code: 'void navigator.clipboard.writeText(text);',
      errors: [{ messageId: 'rawClipboard' }],
    },
    {
      code: 'navigator.clipboard?.writeText(text);',
      errors: [{ messageId: 'rawClipboard' }],
    },
    {
      code: 'if (navigator.clipboard == null) throw new Error("no");',
      errors: [{ messageId: 'rawClipboard' }],
    },
    {
      code: 'window.navigator.clipboard.writeText(text);',
      errors: [{ messageId: 'rawClipboard' }],
    },
    { code: "navigator['clipboard'].readText();", errors: [{ messageId: 'rawClipboard' }] },
    {
      code: '<button onClick={() => navigator.clipboard.writeText(id)} />',
      errors: [{ messageId: 'rawClipboard' }],
    },
  ],
});
