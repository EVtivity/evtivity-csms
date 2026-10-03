// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
] as const;

interface LanguageSelectProps {
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  className?: string | undefined;
}

export function LanguageSelect({
  id,
  value,
  onChange,
  className,
}: LanguageSelectProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      aria-label={id == null ? t('nav.language') : undefined}
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
