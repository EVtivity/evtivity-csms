// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { loadLanguage } from '@/i18n/index';
import { cn } from '@/lib/utils';

const LANGUAGES = [
  { code: 'en', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'es', label: 'Español' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
] as const;

interface LanguageSelectProps {
  className?: string | undefined;
}

export function LanguageSelect({ className }: LanguageSelectProps): React.JSX.Element {
  const { t, i18n } = useTranslation();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="portal-language-select" className="text-sm font-medium text-muted-foreground">
        {t('profile.language')}
      </label>
      <Select
        id="portal-language-select"
        value={i18n.language}
        onChange={(e) => {
          localStorage.setItem('portal_language', e.target.value);
          void loadLanguage(e.target.value);
        }}
        className={cn('h-auto px-1.5 py-1 pr-7', className)}
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

export { LANGUAGES };
