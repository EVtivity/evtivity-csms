// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';

let language = 'en';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language },
  }),
}));

import { DecimalInput, type DecimalInputProps } from '../ui/decimal-input';

function Harness({
  initial,
  onChange,
  ...props
}: {
  initial: string;
  onChange: (value: string) => void;
} & Partial<Pick<DecimalInputProps, 'allowNegative' | 'decimalScale'>>): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <DecimalInput
      aria-label="amount"
      value={value}
      {...props}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

function getInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input');
  if (input == null) throw new Error('input not rendered');
  return input;
}

describe('DecimalInput', () => {
  beforeEach(() => {
    language = 'en';
  });

  it('displays a canonical value with the separator of the UI language', () => {
    language = 'de';
    const { container } = render(<Harness initial="0.4900" onChange={() => {}} />);
    expect(getInput(container).value).toBe('0,4900');
  });

  it('keeps "." for English', () => {
    const { container } = render(<Harness initial="0.49" onChange={() => {}} />);
    expect(getInput(container).value).toBe('0.49');
  });

  it('reports a comma entry as a canonical value in German', () => {
    language = 'de';
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '0,49' } });
    expect(onChange).toHaveBeenLastCalledWith('0.49');
    expect(getInput(container).value).toBe('0,49');
  });

  it('accepts a pasted "." as decimal separator in German', () => {
    language = 'de';
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '0.49' } });
    expect(onChange).toHaveBeenLastCalledWith('0.49');
    expect(getInput(container).value).toBe('0,49');
  });

  it('accepts a pasted "," as decimal separator in English', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '0,49' } });
    expect(onChange).toHaveBeenLastCalledWith('0.49');
    expect(getInput(container).value).toBe('0.49');
  });

  it('ignores pasted text with several separators instead of guessing', () => {
    language = 'de';
    const onChange = vi.fn();
    const { container } = render(<Harness initial="0.49" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '1.000,00' } });
    expect(getInput(container).value).toBe('0,49');
    expect(onChange).not.toHaveBeenCalledWith('1000.00');
    expect(onChange).not.toHaveBeenCalledWith('1.00000');
  });

  it('ignores a second decimal separator', () => {
    language = 'de';
    const { container } = render(<Harness initial="0.4" onChange={() => {}} />);
    fireEvent.change(getInput(container), { target: { value: '0,4.' } });
    expect(getInput(container).value).toBe('0,4');
  });

  it('converts a typed "." into "," while typing in German', () => {
    language = 'de';
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} />);
    const input = getInput(container);
    for (const char of '0.49') {
      const next = input.value + char;
      fireEvent.change(input, {
        target: { value: next, selectionStart: next.length, selectionEnd: next.length },
      });
    }
    expect(input.value).toBe('0,49');
    expect(onChange).toHaveBeenLastCalledWith('0.49');
  });

  it('reports an empty string when cleared', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial="1.5" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('drops non-numeric characters', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '1a2' } });
    expect(onChange).toHaveBeenLastCalledWith('12');
  });

  it('rejects a minus sign unless negatives are allowed', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(getInput(container), { target: { value: '-5' } });
    expect(onChange).toHaveBeenLastCalledWith('5');
  });

  it('keeps a minus sign when negatives are allowed', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} allowNegative />);
    fireEvent.change(getInput(container), { target: { value: '-12.5' } });
    expect(onChange).toHaveBeenLastCalledWith('-12.5');
  });

  it('limits fraction digits to decimalScale', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness initial="" onChange={onChange} decimalScale={2} />);
    fireEvent.change(getInput(container), { target: { value: '1.2345' } });
    expect(onChange).toHaveBeenLastCalledWith('1.23');
  });

  it('does not report prop-driven values as changes', () => {
    const onChange = vi.fn();
    render(<Harness initial="0.25" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('localizes the placeholder', () => {
    language = 'de';
    const { container } = render(
      <DecimalInput aria-label="amount" value="" onChange={() => {}} placeholder="0.25" />,
    );
    expect(getInput(container).placeholder).toBe('0,25');
  });

  it('only localizes numbers inside a descriptive placeholder', () => {
    language = 'de';
    const { container } = render(
      <DecimalInput aria-label="lat" value="" onChange={() => {}} placeholder="e.g. -74.0060" />,
    );
    expect(getInput(container).placeholder).toBe('e.g. -74,0060');
  });

  it('uses a decimal keyboard on mobile', () => {
    const { container } = render(<Harness initial="" onChange={() => {}} />);
    expect(getInput(container).inputMode).toBe('decimal');
    expect(getInput(container).type).toBe('text');
  });
});
