// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import { noRawSwitch } from './no-raw-switch.js';

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

ruleTester.run('no-raw-switch', noRawSwitch, {
  valid: [
    '<Toggle checked={on} onCheckedChange={set} aria-label="Reservations" />',
    '<button type="button" role="tab" />',
    '<div role={kind} />',
  ],
  invalid: [
    {
      code: '<button type="button" role="switch" aria-checked={on} />',
      errors: [{ messageId: 'rawSwitch' }],
    },
    { code: '<span role={"switch"} />', errors: [{ messageId: 'rawSwitch' }] },
    { code: '<div role={`switch`} />', errors: [{ messageId: 'rawSwitch' }] },
  ],
});
