// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Select } from '@/components/ui/select';

const LANGUAGES = [
  { code: 'en', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'es', label: 'Español' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
] as const;

interface LanguageSelectProps {
  value: string;
  onChange: (value: string) => void;
  className?: string | undefined;
}

export function LanguageSelect({
  value,
  onChange,
  className,
}: LanguageSelectProps): React.JSX.Element {
  return (
    <Select
      aria-label="Language"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      className={className}
    >
      {LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.label}
        </option>
      ))}
    </Select>
  );
}

export { LANGUAGES };
