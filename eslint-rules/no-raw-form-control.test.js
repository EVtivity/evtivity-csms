// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import { noRawFormControl } from './no-raw-form-control.js';

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

ruleTester.run('no-raw-form-control', noRawFormControl, {
  valid: [
    '<Input id="name" value={v} />',
    '<Input type="date" value={d} />',
    '<Input type="number" value={n} />',
    '<DateTimeInput id="expires" value={v} onChange={set} />',
    '<TimeInput value={v} onChange={set} />',
    '<Select value={v}><option value="a">A</option></Select>',
    '<Textarea rows={3} />',
    '<Checkbox checked={on} />',
    '<Radio name="mode" />',
    '<input ref={fileRef} type="file" className="hidden" />',
    '<input type="color" value={c} />',
    '<input type="hidden" name="token" />',
    '<button type="button" role="tab" />',
    '<div role="radiogroup" />',
    '<Combobox value={v} onChange={set} options={o} />',
  ],
  invalid: [
    { code: '<select value={v} />', errors: [{ messageId: 'rawSelect' }] },
    { code: '<textarea rows={3} />', errors: [{ messageId: 'rawTextarea' }] },
    { code: '<input type="checkbox" checked={on} />', errors: [{ messageId: 'rawInput' }] },
    { code: '<input type="radio" name="m" />', errors: [{ messageId: 'rawInput' }] },
    { code: '<input value={v} />', errors: [{ messageId: 'rawInput' }] },
    { code: '<input type={kind} />', errors: [{ messageId: 'rawInput' }] },
    {
      code: '<Input type="datetime-local" value={v} />',
      errors: [{ messageId: 'nativePicker' }],
    },
    { code: '<Input type={"time"} value={v} />', errors: [{ messageId: 'nativePicker' }] },
    { code: '<Input type="month" value={v} />', errors: [{ messageId: 'nativePicker' }] },
    { code: '<Input type="week" value={v} />', errors: [{ messageId: 'nativePicker' }] },
    {
      code: '<input type="datetime-local" />',
      errors: [{ messageId: 'rawInput' }, { messageId: 'nativePicker' }],
    },
    { code: '<ul role="listbox" />', errors: [{ messageId: 'rawList' }] },
    { code: '<li role="option" />', errors: [{ messageId: 'rawList' }] },
    { code: '<Input role="combobox" />', errors: [{ messageId: 'rawList' }] },
  ],
});
