// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NumberFormatBase, useNumericFormat } from 'react-number-format';
import { Input, type InputProps } from '@/components/ui/input';
import { getDecimalSeparator } from '@/lib/formatting';

export interface DecimalInputProps extends Omit<
  InputProps,
  | 'type'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'inputMode'
  | 'min'
  | 'max'
  | 'step'
  // Clashes with react-number-format's own prefix option.
  | 'prefix'
> {
  /** Canonical value with "." as decimal separator, or '' when empty. */
  value: string;
  /** Called with the canonical value ("." as decimal separator), or '' when cleared. */
  onChange: (value: string) => void;
  allowNegative?: boolean;
  /** Maximum number of fraction digits the user can enter. */
  decimalScale?: number;
}

const SEPARATORS = /[.,]/g;

/**
 * Text input for decimal numbers that displays and accepts the decimal separator
 * of the selected UI language while exchanging canonical "." strings with the
 * caller, so API payloads never depend on the locale.
 *
 * Thousands separators are not supported, so a single "." or "," is always the
 * decimal separator, whether typed or pasted. Pasted text with several
 * separators (e.g. "1.000,00") is ambiguous across locales and is ignored
 * rather than guessed.
 */
export const DecimalInput = forwardRef<HTMLInputElement, DecimalInputProps>(function DecimalInput(
  { value, onChange, allowNegative = false, decimalScale, placeholder, ...rest },
  ref,
) {
  const { i18n } = useTranslation();
  const decimalSeparator = getDecimalSeparator(i18n.language);

  const { removeFormatting, ...numericProps } = useNumericFormat({
    ...rest,
    customInput: Input,
    getInputRef: ref,
    inputMode: 'decimal',
    valueIsNumericString: true,
    value,
    decimalSeparator,
    allowedDecimalSeparators: ['.', ','],
    thousandSeparator: false,
    allowNegative,
    ...(decimalScale !== undefined ? { decimalScale } : {}),
    placeholder: placeholder?.replace(/(\d)\.(\d)/g, `$1${decimalSeparator}$2`),
    onValueChange: (values, sourceInfo) => {
      // Only report user edits; prop-driven reformatting must not mark forms dirty.
      if (sourceInfo.event !== undefined) onChange(values.value);
    },
  });

  return (
    <NumberFormatBase
      {...numericProps}
      removeFormatting={(inputValue, changeMeta) => {
        if (removeFormatting == null) return inputValue;
        const separatorCount = inputValue.match(SEPARATORS)?.length ?? 0;
        if (separatorCount > 1) {
          return removeFormatting(changeMeta?.lastValue ?? '', undefined);
        }
        // Same length replacement, so the caret positions in changeMeta stay valid.
        return removeFormatting(inputValue.replace(SEPARATORS, decimalSeparator), changeMeta);
      }}
    />
  );
});
