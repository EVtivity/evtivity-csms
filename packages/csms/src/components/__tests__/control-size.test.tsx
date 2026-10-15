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
import { ClearableInput } from '../ui/clearable-input';
import { Combobox } from '../ui/combobox';
import { DecimalInput } from '../ui/decimal-input';
import { MonthPicker } from '../ui/month-picker';
import { LanguageSelect } from '../ui/language-select';
import { SearchInput } from '../search-input';

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/);
}

/** The h-* classes of a class list. */
function heights(el: HTMLElement): string[] {
  return classesOf(el).filter((c) => /^h-\d/.test(c));
}

const noop = (): void => undefined;

afterEach(() => {
  cleanup();
});

describe('CSMS control height (40 px)', () => {
  it('gives the default, sm and icon buttons 40 px', () => {
    expect(buttonVariants({ size: 'default' }).split(' ')).toContain('h-10');
    expect(buttonVariants({ size: 'sm' }).split(' ')).toContain('h-10');
    expect(buttonVariants({ size: 'icon' }).split(' ')).toEqual(
      expect.arrayContaining(['h-10', 'w-10']),
    );
  });

  it('gives every input and select 40 px', () => {
    const { container } = render(
      <>
        <Input aria-label="input" />
        <Select aria-label="select">
          <option>a</option>
        </Select>
        <PasswordInput aria-label="pw" />
        <ClearableInput aria-label="clearable" value="" onChange={noop} />
        <Combobox aria-label="combo" value="" onChange={noop} options={[]} />
        <DecimalInput aria-label="decimal" value="" onChange={noop} />
        <SearchInput placeholder="search" value="" onDebouncedChange={noop} />
        <MonthPicker aria-label="month" value="2026-10" onChange={noop} />
        <LanguageSelect id="lang" value="en" onChange={noop} />
      </>,
    );
    for (const label of ['input', 'select', 'pw', 'clearable', 'combo', 'decimal', 'month']) {
      expect(heights(screen.getByLabelText(label))).toEqual(['h-10']);
    }
    expect(heights(screen.getByPlaceholderText('search'))).toEqual(['h-10']);
    expect(heights(container.querySelector('#lang') as HTMLElement)).toEqual(['h-10']);
  });

  it('sizes the PasswordInput eye button with the field', () => {
    const { container } = render(<PasswordInput aria-label="pw" />);
    const eye = container.querySelector('button');
    expect(eye).not.toBeNull();
    expect(classesOf(eye as HTMLElement)).toEqual(expect.arrayContaining(['h-10', 'w-10']));
  });

  it('keeps layout classes from className', () => {
    render(<Select aria-label="select" className="w-auto" />);
    expect(classesOf(screen.getByLabelText('select'))).toEqual(
      expect.arrayContaining(['h-10', 'w-auto']),
    );
  });
});
