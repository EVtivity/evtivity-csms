// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RuleTester } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';
import { heightClasses, noControlHeightClass } from './no-control-height-class.js';

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

const error = { messageId: 'heightClass' };

ruleTester.run('no-control-height-class', noControlHeightClass, {
  valid: [
    '<Select size="sm" className="w-auto" />',
    '<Input className="pl-9 pr-9 w-full" />',
    '<Button size="icon-sm" className="ml-auto shrink-0" />',
    '<SaveButton className="mt-4" />',
    '<SearchInput size="sm" className="flex-1 md:max-w-xs" />',
    '<Input className={cn("w-40", invalid && "border-destructive")} />',
    '<Input className={classes} />',
    // Not a control: layout elements keep their heights.
    '<div className="h-10 py-2" />',
    '<Textarea className="min-h-[120px]" />',
    '<Link className={buttonVariants({ variant: "outline", size: "sm" })} />',
    '<Link className={cn(buttonVariants({ size: "sm" }), "w-full")} />',
    // The h-4 here sizes the icon inside, not the button.
    '<Button size="sm"><Plus className="h-4 w-4" /></Button>',
    '<Button size="sm" className="[&>svg]:h-3 [&>svg]:w-3" />',
  ],
  invalid: [
    { code: '<Select className="h-9 w-auto" />', errors: [error] },
    { code: '<Input className="h-8" />', errors: [error] },
    { code: '<SearchInput className="h-10 w-full" />', errors: [error] },
    { code: '<PasswordInput className="py-3" />', errors: [error] },
    { code: '<ClearableInput className="min-h-12" />', errors: [error] },
    { code: '<Combobox className="h-[38px]" />', errors: [error] },
    { code: '<Button size="icon" className="h-7 w-7" />', errors: [error] },
    { code: '<Button className="h-11 sm:h-10" />', errors: [error] },
    { code: '<Button className="h-auto p-0 text-xs" />', errors: [error] },
    { code: '<Button className="size-8" />', errors: [error] },
    { code: '<RefreshButton className="pt-1" />', errors: [error] },
    { code: '<Select className={`h-9 ${errorClass}`} />', errors: [error] },
    {
      code: '<Select className={bad ? "h-9 border-destructive" : "h-9"} />',
      errors: [error, error],
    },
    { code: '<Input className={cn("pl-9", small && "h-8")} />', errors: [error] },
    { code: '<Button className={cn(active && "!h-6")} />', errors: [error] },
    { code: '<ui.Select className="h-9" />', errors: [error] },
    {
      code: '<Link className={buttonVariants({ size: "sm", className: "h-8" })} />',
      errors: [error],
    },
    {
      code: '<Link className={cn(buttonVariants({ size: "sm" }), "h-8 w-full")} />',
      errors: [error],
    },
  ],
});

describe('heightClasses', () => {
  it('finds height classes behind variant prefixes and arbitrary values', () => {
    expect(heightClasses('w-full sm:h-10 md:py-2 h-[38px] -mt-1 hover:!h-6')).toEqual([
      'sm:h-10',
      'md:py-2',
      'h-[38px]',
      'hover:!h-6',
    ]);
  });

  it('leaves classes that style the children', () => {
    expect(heightClasses('[&>svg]:h-4 *:h-4 md:[&_svg]:h-5')).toEqual([]);
  });

  it('keeps width, margin and other padding', () => {
    expect(heightClasses('w-10 px-3 pl-9 mx-auto mt-2 leading-6')).toEqual([]);
  });
});
