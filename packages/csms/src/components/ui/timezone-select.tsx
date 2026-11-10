// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Select } from '@/components/ui/select';
import { TIMEZONE_OPTIONS } from '@/lib/timezone-options';

/** The label of a listed zone, else the IANA name itself. */
export function timezoneLabel(value: string): string {
  return TIMEZONE_OPTIONS.find((opt) => opt.value === value)?.label ?? value;
}

interface TimezoneSelectProps {
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
}

/**
 * The IANA time zones of TIMEZONE_OPTIONS. A value outside the list (a zone
 * set through the API) stays selectable, so the form never changes it unseen.
 */
export function TimezoneSelect({
  id,
  value,
  onChange,
  disabled,
}: TimezoneSelectProps): React.JSX.Element {
  const listed = TIMEZONE_OPTIONS.some((opt) => opt.value === value);
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {!listed && value !== '' && <option value={value}>{value}</option>}
      {TIMEZONE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </Select>
  );
}
