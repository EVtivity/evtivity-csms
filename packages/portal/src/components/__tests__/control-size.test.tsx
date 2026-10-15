// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { buttonVariants } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { PasswordInput } from '../ui/password-input';
import { Combobox } from '../ui/combobox';

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/);
}

function heights(el: HTMLElement): string[] {
  return classesOf(el).filter((c) => /^h-\d/.test(c));
}

const noop = (): void => undefined;

afterEach(() => {
  cleanup();
});

describe('portal control heights', () => {
  it('gives buttons 40 px by default and a wrapping row size of at least 48 px', () => {
    expect(buttonVariants({ size: 'default' }).split(' ')).toContain('h-10');
    expect(buttonVariants({ size: 'icon' }).split(' ')).toEqual(
      expect.arrayContaining(['h-10', 'w-10']),
    );
    expect(buttonVariants({ size: 'row' }).split(' ')).toEqual(
      expect.arrayContaining(['h-auto', 'min-h-12', 'whitespace-normal']),
    );
  });

  it('gives inputs, selects, password and combobox fields 48 px', () => {
    render(
      <>
        <Input aria-label="input" />
        <Select aria-label="select">
          <option>a</option>
        </Select>
        <PasswordInput aria-label="pw" />
        <Combobox aria-label="combo" value="" onChange={noop} options={[]} />
      </>,
    );
    for (const label of ['input', 'select', 'pw', 'combo']) {
      expect(heights(screen.getByLabelText(label))).toEqual(['h-12']);
    }
  });

  it('sizes the PasswordInput eye button with the field', () => {
    const { container } = render(<PasswordInput aria-label="pw" />);
    const eye = container.querySelector('button');
    expect(eye).not.toBeNull();
    expect(classesOf(eye as HTMLElement)).toEqual(expect.arrayContaining(['h-12', 'w-12']));
  });
});
